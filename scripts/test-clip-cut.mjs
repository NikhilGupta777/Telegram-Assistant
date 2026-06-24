// Live VMS API smoke test for clip-cut. Reads VMS_API_KEY from .env and
// never prints it. Submits a clip-cut job, polls until terminal, prints
// only the result URL (which is the test's actual purpose).
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1)];
    }),
);

const KEY = env.VMS_API_KEY;
if (!KEY) {
  console.error("VMS_API_KEY missing from .env");
  process.exit(1);
}

const BASE = "https://videomaking.in";
const headers = {
  Authorization: `Bearer ${KEY}`,
  "Content-Type": "application/json",
};

// 1:23 = 83s, 1:54 = 114s.
const payload = {
  url: "https://youtu.be/2xKcKBEOAj8",
  startTime: 83,
  endTime: 114,
};

const tStart = Date.now();
const elapsed = () => `${Math.round((Date.now() - tStart) / 1000)}s`;

console.log(`[${elapsed()}] POST /api/v1/clip-cut  (1:23 → 1:54 of 2xKcKBEOAj8)`);
const r1 = await fetch(`${BASE}/api/v1/clip-cut`, {
  method: "POST",
  headers,
  body: JSON.stringify(payload),
});
const submit = await r1.json().catch(() => ({}));
if (!r1.ok) {
  console.error(`POST failed: HTTP ${r1.status}`, submit);
  process.exit(1);
}
const jobId = submit.jobId ?? submit.id;
console.log(`[${elapsed()}] jobId=${jobId}  status=${submit.status}`);

let last = "";
for (let i = 0; i < 240; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const r2 = await fetch(`${BASE}/api/v1/jobs/${jobId}`, { headers });
  const job = await r2.json().catch(() => ({}));
  if (!r2.ok) {
    console.error(`poll failed: HTTP ${r2.status}`, job);
    process.exit(1);
  }
  const line = `${job.status}${job.progress != null ? ` ${job.progress}%` : ""}${
    job.message ? ` — ${String(job.message).slice(0, 80)}` : ""
  }`;
  if (line !== last) {
    console.log(`[${elapsed()}] ${line}`);
    last = line;
  }
  const terminal =
    job.terminal ||
    job.succeeded ||
    job.failed ||
    ["done", "error", "failed", "cancelled", "expired"].includes(job.status);
  if (terminal) {
    if (job.succeeded || job.status === "done") {
      const url =
        job.result?.url ??
        job.result?.downloadUrl ??
        job.result?.fileUrl ??
        job.result?.type === "file"
          ? job.result?.url
          : undefined;
      console.log(`[${elapsed()}] ✅ SUCCESS`);
      console.log(`result.url: ${url ?? "(missing — full result below)"}`);
      console.log(JSON.stringify(job.result ?? {}, null, 2));
    } else {
      console.log(`[${elapsed()}] ❌ FAILED  code=${job.errorCode ?? job.code ?? "?"}`);
      console.log(`message: ${job.message ?? "(none)"}`);
    }
    process.exit(0);
  }
}
console.error("timed out after 12 minutes");
process.exit(1);
