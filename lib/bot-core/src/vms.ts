import { createHmac, timingSafeEqual } from "node:crypto";

const BASE = "https://videomaking.in";

function getHeaders(idempotencyKey?: string): Record<string, string> {
  const key = process.env["VMS_API_KEY"];
  if (!key) throw new Error("VMS_API_KEY not set");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  return headers;
}

// ─── Types ──────────────────────────────────────────────────────────────────

export type JobStatus =
  | "pending"
  | "queued"
  | "running"
  | "done"
  | "error"
  | "cancelled"
  | "expired"
  | "failed";

export interface JobEnvelope {
  jobId: string;
  status: string;
  statusUrl?: string;
  eventsUrl?: string;
  cancelUrl?: string;
  terminal?: boolean;
  succeeded?: boolean;
  failed?: boolean;
  result?: Record<string, unknown>;
  message?: string;
  progress?: number;
}

/** Shape of the body VMS POSTs to our webhookUrl on completion. */
export interface VmsWebhookPayload {
  jobId: string;
  status: string;
  succeeded?: boolean;
  failed?: boolean;
  result?: Record<string, unknown>;
  message?: string;
  timestamp?: number;
}

/** Structured error so callers can map VMS error codes to friendly messages. */
export class VmsError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly code?: string,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "VmsError";
  }
}

const TERMINAL_STATUSES = new Set<string>([
  "done",
  "error",
  "cancelled",
  "expired",
  "failed",
]);

export function isTerminal(job: JobEnvelope): boolean {
  return !!(
    job.terminal ||
    job.succeeded ||
    job.failed ||
    TERMINAL_STATUSES.has(job.status)
  );
}

export function isSucceeded(job: JobEnvelope): boolean {
  return job.succeeded === true || (job.status === "done" && !job.failed);
}

// ─── HTTP with retry ────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries = 3,
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.status === 429 || res.status >= 500) {
        const retryAfter =
          Number(res.headers.get("retry-after")) || 2 ** attempt * 2;
        if (attempt < maxRetries) {
          await sleep(retryAfter * 1000);
          continue;
        }
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) await sleep(2 ** attempt * 1000);
    }
  }
  throw lastErr ?? new Error("Network request failed after retries");
}

/** Parse an error response body into a VmsError with a friendly message. */
async function toVmsError(res: Response): Promise<VmsError> {
  const raw = await res.text();
  let code: string | undefined;
  let message = raw;
  try {
    const parsed = JSON.parse(raw) as {
      error?: { code?: string; message?: string };
      code?: string;
      message?: string;
    };
    code = parsed.error?.code ?? parsed.code;
    message = parsed.error?.message ?? parsed.message ?? raw;
  } catch {
    /* keep raw */
  }
  const retryAfter = Number(res.headers.get("retry-after")) || undefined;
  return new VmsError(message || `HTTP ${res.status}`, res.status, code, retryAfter);
}

// ─── API calls ──────────────────────────────────────────────────────────────

export interface StartJobOptions {
  /** VMS calls this URL on completion. */
  webhookUrl?: string;
  /** Safe-retry key so duplicate POSTs don't create duplicate jobs. */
  idempotencyKey?: string;
}

export async function startJob(
  endpoint: string,
  payload: Record<string, unknown>,
  opts: StartJobOptions = {},
): Promise<JobEnvelope> {
  const body = { ...payload };
  if (opts.webhookUrl) body["webhookUrl"] = opts.webhookUrl;

  const res = await fetchWithRetry(`${BASE}/api/v1/${endpoint}`, {
    method: "POST",
    headers: getHeaders(opts.idempotencyKey),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await toVmsError(res);
  return (await res.json()) as JobEnvelope;
}

export async function pollJob(jobId: string): Promise<JobEnvelope> {
  const res = await fetchWithRetry(`${BASE}/api/v1/jobs/${jobId}`, {
    headers: getHeaders(),
  });
  if (!res.ok) throw await toVmsError(res);
  return (await res.json()) as JobEnvelope;
}

export async function cancelJob(jobId: string): Promise<boolean> {
  const res = await fetchWithRetry(`${BASE}/api/v1/jobs/${jobId}/cancel`, {
    method: "POST",
    headers: getHeaders(),
  });
  return res.ok;
}

/**
 * Poll until terminal. Used by the local dev runner (no webhook).
 * Lambda mode uses webhooks instead and never calls this.
 */
export async function waitForJob(
  jobId: string,
  onProgress?: (job: JobEnvelope) => Promise<void> | void,
  intervalMs = 5000,
  timeoutMs = 10 * 60 * 1000,
): Promise<JobEnvelope> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error(
        "Job timed out after 10 minutes. The video may be very long — try a shorter clip.",
      );
    }
    const job = await pollJob(jobId);
    if (onProgress) {
      try {
        await onProgress(job);
      } catch {
        /* progress errors are non-fatal */
      }
    }
    if (isTerminal(job)) return job;
    await sleep(intervalMs);
  }
}

// ─── Webhook signature verification ─────────────────────────────────────────

/**
 * Verify the `X-VMS-Signature` HMAC-SHA256 header on an incoming VMS webhook.
 * `rawBody` MUST be the exact bytes received (not re-serialized JSON).
 * Returns false on any mismatch or malformed input — never throws.
 */
export function verifySignature(
  rawBody: string,
  signature: string | undefined,
  secret: string | undefined,
): boolean {
  if (!signature || !secret) return false;
  // Accept "sha256=<hex>" or bare hex.
  const provided = signature.startsWith("sha256=")
    ? signature.slice("sha256=".length)
    : signature;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  try {
    const a = Buffer.from(provided, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length || a.length === 0) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
