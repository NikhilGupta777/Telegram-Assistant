// Local test that mirrors the bot's Lambda A path exactly:
//   1. Generate the same idempotency key shape Lambda A uses
//   2. POST /api/v1/clip-cut with webhookUrl (the real Lambda B URL)
//      and the idempotency key
//   3. If the returned envelope is already terminal → pollJob and report
//      immediately (the new "idempotency-replay" code path)
//   4. Otherwise poll until terminal and report
//
// VMS_API_KEY is read from .env but never printed.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

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
const WEBHOOK_URL =
  "https://5bkyxuafuewevru35ibpvtysea0jeywc.lambda-url.us-east-1.on.aws/";

const headers = (idempotencyKey) => {
  const h = {
    Authorization: `Bearer ${KEY}`,
    "Content-Type": "application/json",
  };
  if (idempotencyKey) h["Idempotency-Key"] = idempotencyKey;
  return h;
};

function isTerminal(env) {
  return Boolean(
    env.terminal ||
      env.succeeded ||
      env.failed ||
      ["done", "error", "failed", "cancelled", "expired"].includes(env.status),
  );
}

async function startJob(payload, idempotencyKey) {
  const body = { ...payload, webhookUrl: WEBHOOK_URL };
  const r = await fetch(`${BASE}/api/v1/clip-cut`, {
    method: "POST",
    headers: headers(idempotencyKey),
    body: JSON.stringify(body),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`POST failed: HTTP ${r.status} ${JSON.stringify(json)}`);
  return { envelope: json, replayed: r.headers.get("idempotent-replayed") === "true" };
}

async function pollJob(jobId) {
  const r = await fetch(`${BASE}/api/v1/jobs/${jobId}`, { headers: headers() });
  if (!r.ok) throw new Error(`poll HTTP ${r.status}`);
  return r.json();
}

function pickUrl(result = {}) {
  return result.url ?? result.downloadUrl ?? result.fileUrl;
}

async function runBotFlow({ label, startTime, endTime, userId = 6500195147 }) {
  const url = "https://youtu.be/2xKcKBEOAj8";
  const payload = { url, startTime, endTime };

  // Same shape Lambda A uses (telegram-lambda/src/index.ts).
  const idempotencyKey = `${userId}:clip-cut:${JSON.stringify(payload)}`.slice(0, 200);

  console.log(`\n=== ${label} ===`);
  console.log(`URL=${url}  cut=${startTime}-${endTime}s  user=${userId}`);
  console.log(`idempotency-key (sha): ${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 16)}…`);

  const t0 = Date.now();
  const lap = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`;

  const { envelope, replayed } = await startJob(payload, idempotencyKey);
  console.log(`[${lap()}] POST returned  jobId=${envelope.jobId}  status=${envelope.status}  replayed=${replayed}`);

  if (isTerminal(envelope)) {
    // Same shortcut Lambda A now takes.
    console.log(`[${lap()}] envelope is terminal → pollJob shortcut`);
    const full = await pollJob(envelope.jobId).catch(() => envelope);
    const downloadUrl = pickUrl(full.result);
    console.log(`[${lap()}] DONE  url=${downloadUrl ?? "(missing!)"}`);
    return { totalSec: (Date.now() - t0) / 1000, replayed, downloadUrl };
  }

  // Fresh job — poll every 2s like a typical client would.
  for (let i = 0; i < 240; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const cur = await pollJob(envelope.jobId);
    process.stdout.write(`\r[${lap()}] ${cur.status}${cur.progress != null ? ` ${cur.progress}%` : ""}${cur.message ? ` — ${String(cur.message).slice(0, 60)}` : ""}   `);
    if (isTerminal(cur)) {
      const downloadUrl = pickUrl(cur.result);
      console.log(`\n[${lap()}] DONE  url=${downloadUrl ?? "(missing!)"}`);
      return { totalSec: (Date.now() - t0) / 1000, replayed: false, downloadUrl };
    }
  }
  throw new Error("polling timed out");
}

// Run two scenarios back to back:
//   1. fresh cut with a new times pair → exercises the normal flow
//   2. same cut again → exercises the idempotency-replay shortcut
const T1 = 87, T2 = 113; // 1:23 → 1:53  (avoids overlap with prior tested ranges)
const first = await runBotFlow({ label: "Fresh clip-cut (first call)", startTime: T1, endTime: T2 });
const second = await runBotFlow({ label: "Same clip-cut again (idempotency replay)", startTime: T1, endTime: T2 });

console.log("\n──────────────────── Summary ────────────────────");
console.log(`Fresh call:        ${first.totalSec.toFixed(2)}s   replayed=${first.replayed}`);
console.log(`Idempotent call:   ${second.totalSec.toFixed(2)}s   replayed=${second.replayed}`);
console.log(`URLs match:        ${first.downloadUrl === second.downloadUrl}`);
