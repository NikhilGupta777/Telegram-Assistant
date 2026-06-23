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

export async function startJob(
  endpoint: string,
  payload: Record<string, unknown>,
): Promise<JobEnvelope> {
  const res = await fetch(`${BASE}/api/v1/${endpoint}`, {
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
  const res = await fetch(`${BASE}/api/v1/jobs/${jobId}`, {
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
  onProgress?: (job: JobEnvelope) => void,
  intervalMs = 5000,
  timeoutMs = 10 * 60 * 1000,
): Promise<JobEnvelope> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (Date.now() > deadline) throw new Error("Job timed out after 10 minutes");
    const job = await pollJob(jobId);
    if (onProgress) onProgress(job);
    if (job.terminal || job.succeeded || job.failed || job.status === "done" || job.status === "error" || job.status === "cancelled" || job.status === "expired") {
      return job;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export async function cancelJob(jobId: string): Promise<void> {
  await fetch(`${BASE}/api/v1/jobs/${jobId}/cancel`, {
    method: "POST",
    headers: getHeaders(),
  });
}
