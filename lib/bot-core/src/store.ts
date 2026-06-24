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
  feature: Feature;
  /** message_id of the "working…" status message, to edit/delete later. */
  statusMessageId?: number;
  createdAt: number;
}

export interface JobStore {
  put(mapping: JobMapping): Promise<void>;
  getJob(jobId: string): Promise<JobMapping | null>;
  delete(jobId: string): Promise<void>;
  /** Returns true if the user has no in-flight job and the lock was taken. */
  tryLock(userId: number): Promise<boolean>;
  unlock(userId: number): Promise<void>;
}

/** In-memory job store for the local dev runner. */
export class MemoryJobStore implements JobStore {
  private readonly jobs = new Map<string, JobMapping>();
  private readonly locks = new Set<number>();

  async put(mapping: JobMapping): Promise<void> {
    this.jobs.set(mapping.jobId, mapping);
  }
  async getJob(jobId: string): Promise<JobMapping | null> {
    return this.jobs.get(jobId) ?? null;
  }
  async delete(jobId: string): Promise<void> {
    this.jobs.delete(jobId);
  }
  async tryLock(userId: number): Promise<boolean> {
    if (this.locks.has(userId)) return false;
    this.locks.add(userId);
    return true;
  }
  async unlock(userId: number): Promise<void> {
    this.locks.delete(userId);
  }
}
