// Watch International-3's Actions for a new successful Deploy of the
// fix commit (cf5cedf), then run the clip-cut test against the live VMS API
// and time it. VMS_API_KEY is read from .env but never printed.

import { readFileSync } from "node:fs";
import { execSync, spawn } from "node:child_process";

const INT3_DIR = "C:/Users/g_n-n/Desktop/apps/international-3 clone/International-3";
const TARGET_COMMIT_SHORT = "cf5cedf";
const POLL_MS = 30_000;
const TIMEOUT_MS = 60 * 60 * 1000; // 1 hour max wait

function gh(args) {
  return execSync(`gh ${args}`, { cwd: INT3_DIR, encoding: "utf8" });
}

function findDeployRun() {
  // List recent runs as JSON to filter precisely.
  const raw = gh(
    `run list --workflow="Deploy to Production" --limit 6 --json databaseId,headSha,status,conclusion,createdAt,event`,
  );
  const runs = JSON.parse(raw);
  // Match the fix commit by short SHA prefix and require completed+success.
  return runs.find(
    (r) =>
      r.headSha?.startsWith(TARGET_COMMIT_SHORT) &&
      r.status === "completed" &&
      r.conclusion === "success",
  );
}

function loadEnv() {
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
  if (!env.VMS_API_KEY) throw new Error("VMS_API_KEY missing from .env");
  return env;
}

async function runClipCutTest() {
  const env = loadEnv();
  const BASE = "https://videomaking.in";
  const headers = {
    Authorization: `Bearer ${env.VMS_API_KEY}`,
    "Content-Type": "application/json",
  };
  const payload = {
    url: "https://youtu.be/2xKcKBEOAj8",
    startTime: 83,
    endTime: 114,
  };

  const t0 = Date.now();
  const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

  console.log(`[${elapsed()}] POST /api/v1/clip-cut  (1:23 → 1:54)`);
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
      const totalSec = ((Date.now() - t0) / 1000).toFixed(1);
      if (job.succeeded || job.status === "done") {
        const url =
          job.result?.url ?? job.result?.downloadUrl ?? job.result?.fileUrl;
        console.log(`\n✅ SUCCESS in ${totalSec}s`);
        console.log(`result.url: ${url ?? "(missing)"}`);
      } else {
        console.log(`\n❌ FAILED in ${totalSec}s`);
        console.log(`code: ${job.errorCode ?? job.code ?? "?"}`);
        console.log(`message: ${job.message ?? "(none)"}`);
      }
      return;
    }
  }
  console.error("Timed out after 12 minutes of polling.");
  process.exit(1);
}

console.log(
  `Watching for successful Deploy of ${TARGET_COMMIT_SHORT} on International-3 (polling every ${POLL_MS / 1000}s)...`,
);

const tWatchStart = Date.now();
const tick = setInterval(async () => {
  try {
    const run = findDeployRun();
    if (run) {
      clearInterval(tick);
      console.log(
        `\n✅ Deploy succeeded: run #${run.databaseId} at ${run.createdAt}`,
      );
      console.log(`Now running live clip-cut test...\n`);
      try {
        await runClipCutTest();
      } catch (err) {
        console.error("Test failed:", err.message);
        process.exit(1);
      }
      return;
    }
  } catch (err) {
    console.error("[watch] gh error:", String(err).slice(0, 200));
  }
  if (Date.now() - tWatchStart > TIMEOUT_MS) {
    console.error("Timed out waiting for deploy after 1 hour.");
    clearInterval(tick);
    process.exit(1);
  }
}, POLL_MS);
