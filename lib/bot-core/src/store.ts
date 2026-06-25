import type { SessionState } from "./flow.js";
import type { Feature } from "./format.js";

// ─── Session store ───────────────────────────────────────────────────────────

export interface SessionStore {
  get(userId: number): Promise<SessionState>;
  set(userId: number, patch: Partial<SessionState>): Promise<void>;
  clear(userId: number): Promise<void>;
}

const SESSION_TTL = 30 * 60 * 1000;

/** In-memory session store for the local/single-process dev runner. */
export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<number, SessionState>();

  constructor() {
    // Periodic sweep of expired sessions.
    const timer = setInterval(() => {
      const now = Date.now();
      for (const [id, s] of this.sessions) {
        if (s.expiresAt && now > s.expiresAt) this.sessions.delete(id);
      }
    }, 15 * 60 * 1000);
    // Don't keep the process alive just for the sweeper.
    if (typeof timer.unref === "function") timer.unref();
  }

  async get(userId: number): Promise<SessionState> {
    const s = this.sessions.get(userId);
    if (!s || (s.expiresAt && Date.now() > s.expiresAt)) {
      const fresh: SessionState = { expiresAt: Date.now() + SESSION_TTL };
      this.sessions.set(userId, fresh);
      return fresh;
    }
    return s;
  }

  async set(userId: number, patch: Partial<SessionState>): Promise<void> {
    const s = await this.get(userId);
    Object.assign(s, patch, { expiresAt: Date.now() + SESSION_TTL });
    this.sessions.set(userId, s);
  }

  async clear(userId: number): Promise<void> {
    this.sessions.set(userId, { expiresAt: Date.now() + SESSION_TTL });
  }
}

// ─── Job mapping store (jobId → who to notify) ───────────────────────────────

export interface JobMapping {
  jobId: string;
  chatId: number;
  userId: number;
  username?: string;
  payload?: Record<string, unknown>;
  feature: Feature;
  /** message_id of the "working…" status message, to edit/delete later. */
  statusMessageId?: number;
  createdAt: number;
}

export interface JobStore {
  put(mapping: JobMapping): Promise<void>;
  getJob(jobId: string): Promise<JobMapping | null>;
  delete(jobId: string): Promise<void>;
  /**
   * Rate-limit gate. Returns true if the user is allowed to start another job
   * (under the per-user window cap), false if they've hit the limit. NOTE: this
   * is a rate limiter, NOT a single-in-flight mutex — both the in-memory and
   * DynamoDB stores allow several concurrent jobs up to the window cap. Per-job
   * tracking for /cancel is handled separately via setLockJob/getActiveJobId.
   */
  tryLock(userId: number): Promise<boolean>;
  /** Record which VMS jobId belongs to the current lock. Call after startJob. */
  setLockJob(userId: number, jobId: string): Promise<void>;
  /** Returns the jobId for the user's active lock, or null if not locked. */
  getActiveJobId(userId: number): Promise<string | null>;
  unlock(userId: number, jobId?: string): Promise<void>;
  /**
   * Atomic exactly-once delivery claim. Returns true if THIS caller won the
   * race to deliver the result for `jobId` (and should call deliverResult);
   * false if someone else already claimed it. Implemented as a conditional
   * write on the JOB# row — `SET delivered=true IF attribute_not_exists`.
   */
  markDelivered(jobId: string): Promise<boolean>;
}

/**
 * In-memory job store for the local dev runner. Mirrors DynamoStore semantics:
 * a fixed-window rate limit (max 15 / 3 min) plus a separate set of active
 * jobIds per user for /cancel.
 */
export class MemoryJobStore implements JobStore {
  private static readonly RATE_WINDOW_MS = 3 * 60 * 1000;
  private static readonly RATE_MAX = 15;

  private readonly jobs = new Map<string, JobMapping>();
  // userId → set of in-flight jobIds (for /cancel + getActiveJobId).
  private readonly locks = new Map<number, Set<string>>();
  // `${userId}#${windowStart}` → count, for the fixed-window rate limit.
  private readonly rate = new Map<string, number>();
  private readonly delivered = new Set<string>();

  async put(mapping: JobMapping): Promise<void> {
    this.jobs.set(mapping.jobId, mapping);
  }
  async getJob(jobId: string): Promise<JobMapping | null> {
    return this.jobs.get(jobId) ?? null;
  }
  async delete(jobId: string): Promise<void> {
    this.jobs.delete(jobId);
    this.delivered.delete(jobId);
  }
  async tryLock(userId: number): Promise<boolean> {
    const windowStart =
      Math.floor(Date.now() / MemoryJobStore.RATE_WINDOW_MS) *
      MemoryJobStore.RATE_WINDOW_MS;
    const key = `${userId}#${windowStart}`;
    const count = (this.rate.get(key) ?? 0) + 1;
    this.rate.set(key, count);
    // Drop stale windows so the map can't grow unbounded over a long session.
    for (const k of this.rate.keys()) {
      if (!k.endsWith(`#${windowStart}`)) this.rate.delete(k);
    }
    return count <= MemoryJobStore.RATE_MAX;
  }
  async setLockJob(userId: number, jobId: string): Promise<void> {
    if (!jobId) return;
    const set = this.locks.get(userId) ?? new Set<string>();
    set.add(jobId);
    this.locks.set(userId, set);
  }
  async getActiveJobId(userId: number): Promise<string | null> {
    const set = this.locks.get(userId);
    if (!set || set.size === 0) return null;
    return Array.from(set).join(",");
  }
  async unlock(userId: number, jobId?: string): Promise<void> {
    if (jobId) {
      const set = this.locks.get(userId);
      if (set) {
        set.delete(jobId);
        if (set.size === 0) this.locks.delete(userId);
      }
      return;
    }
    this.locks.delete(userId);
  }
  async markDelivered(jobId: string): Promise<boolean> {
    if (this.delivered.has(jobId)) return false;
    this.delivered.add(jobId);
    return true;
  }
}
