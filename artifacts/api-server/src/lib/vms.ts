const BASE = "https://videomaking.in";

function getHeaders() {
  const key = process.env["VMS_API_KEY"];
  if (!key) throw new Error("VMS_API_KEY not set");
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}

export interface JobEnvelope {
  jobId: string;
  status: string;
  statusUrl: string;
  eventsUrl?: string;
  cancelUrl?: string;
  terminal?: boolean;
  succeeded?: boolean;
  failed?: boolean;
  result?: Record<string, unknown>;
  message?: string;
  progress?: number;
}

const TERMINAL_STATUSES = new Set([
  "done",
  "error",
  "cancelled",
  "expired",
  "failed",
]);

function isTerminal(job: JobEnvelope): boolean {
  return !!(
    job.terminal ||
    job.succeeded ||
    job.failed ||
    TERMINAL_STATUSES.has(job.status)
  );
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
      // Retry on rate-limit or server errors (but not client errors like 4xx)
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
      if (attempt < maxRetries) {
        await sleep(2 ** attempt * 1000); // exponential backoff
      }
    }
  }
  throw lastErr ?? new Error("Network request failed after retries");
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

export async function startJob(
  endpoint: string,
  payload: Record<string, unknown>,
): Promise<JobEnvelope> {
  const res = await fetchWithRetry(`${BASE}/api/v1/${endpoint}`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`VMS API error ${res.status}: ${text}`);
  }
  return res.json() as Promise<JobEnvelope>;
}

export async function pollJob(jobId: string): Promise<JobEnvelope> {
  const res = await fetchWithRetry(`${BASE}/api/v1/jobs/${jobId}`, {
    headers: getHeaders(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Poll error ${res.status}: ${text}`);
  }
  return res.json() as Promise<JobEnvelope>;
}

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
        /* progress callback errors are non-fatal */
      }
    }

    if (isTerminal(job)) return job;

    await sleep(intervalMs);
  }
}

export async function cancelJob(jobId: string): Promise<void> {
  await fetchWithRetry(`${BASE}/api/v1/jobs/${jobId}/cancel`, {
    method: "POST",
    headers: getHeaders(),
  });
}
