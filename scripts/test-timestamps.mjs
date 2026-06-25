// Live test: hit VMS /api/v1/timestamps for the user's video and print
// what VMS actually returns. VMS_API_KEY read from .env, never printed.
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
const TARGET = "https://youtu.be/t7z4IMPVXrY?si=CmZC-x3zV1mmgUG1";

const t0 = Date.now();
const lap = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`;

console.log(`[${lap()}] POST /api/v1/timestamps  ${TARGET}`);
const r1 = await fetch(`${BASE}/api/v1/timestamps`, {
  method: "POST",
  headers,
  body: JSON.stringify({ url: TARGET }),
});
const submit = await r1.json().catch(() => ({}));
if (!r1.ok) {
  console.error("POST failed:", r1.status, submit);
  process.exit(1);
}
console.log(`[${lap()}] jobId=${submit.jobId}  status=${submit.status}`);

let last = "";
for (let i = 0; i < 240; i++) {
  await new Promise((r) => setTimeout(r, 2500));
  const r2 = await fetch(`${BASE}/api/v1/jobs/${submit.jobId}`, { headers });
  const job = await r2.json().catch(() => ({}));
  const line = `${job.status}${job.progress != null ? ` ${job.progress}%` : ""}${
    job.message ? ` — ${String(job.message).slice(0, 60)}` : ""
  }`;
  if (line !== last) {
    console.log(`[${lap()}] ${line}`);
    last = line;
  }
  const terminal =
    job.terminal || job.succeeded || job.failed ||
    ["done", "error", "failed", "cancelled", "expired"].includes(job.status);
  if (terminal) {
    console.log(`\n=== TERMINAL after ${lap()} ===`);
    console.log("status:", job.status);
    console.log("result keys:", Object.keys(job.result ?? {}));
    console.log("\nFull result JSON (truncated to 4 KB):");
    console.log(JSON.stringify(job.result ?? {}, null, 2).slice(0, 4096));
    // Highlight what the bot's formatter looks for.
    const ts = (job.result?.timestamps ?? job.result?.chapters);
    if (Array.isArray(ts)) {
      console.log(`\nFound ${ts.length} chapter rows. Field shapes:`);
      console.log(JSON.stringify(ts.slice(0, 3), null, 2));
      const allZero = ts.every((c) => (c.time ?? c.start ?? 0) === 0);
      console.log(`\nALL ROWS HAVE time=0? → ${allZero}`);
    } else {
      console.log("\n⚠️ no `timestamps` or `chapters` array in result");
    }
    process.exit(0);
  }
}
console.error("timed out");
process.exit(1);
