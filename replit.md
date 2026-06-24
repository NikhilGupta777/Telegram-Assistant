# Narayan Bhakt Editor — Telegram bot

A Telegram bot (`@NarayanBhaktBot`) that wraps the **VideoMaking Studio (VMS)**
API. Users tap a feature, paste a YouTube link, and get the result back in chat:
Best Clips, Clip Cut, Subtitles, Timestamps, and Download.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — local dev runner (port from `PORT`)
- `pnpm test` — vitest unit suite for the pure core logic
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages (incl. Lambda bundles)
- `pnpm run deploy` — build Lambda bundles + `sam deploy` (see `DEPLOY.md`)
- `pnpm --filter @workspace/db run push` — push DB schema (only if using `/history`)

Required env (local): `TELEGRAM_BOT_TOKEN`, `VMS_API_KEY`. See `.env.example`.

## Stack

- pnpm workspaces, Node 22, TypeScript 5.9
- Telegram: Telegraf 4
- AWS deploy: 2 Lambdas (Function URLs) + DynamoDB + SSM, via AWS SAM
- DB (optional): PostgreSQL + Drizzle ORM (powers `/history`)
- Build: esbuild (per-Lambda single-file bundle; AWS SDK externalized)

## Where things live

- **`lib/bot-core`** — the heart. Pure, host-agnostic, fully tested:
  - `flow.ts` — the conversation state machine (returns plain actions, no I/O)
  - `format.ts` — result formatting, time parsing, Telegram length caps, HTML escaping
  - `vms.ts` — VMS API client (webhookUrl, idempotency, HMAC verify)
  - `store.ts` / `store-dynamo.ts` — session + job stores (memory / DynamoDB)
  - `telegram.ts` — `createBot()` factory shared by all hosts (`./telegram` export)
  - `deliver.ts` — sends a finished job to a chat (used by Lambda B + local)
  - `config.ts` — SSM secret loading (`./config` export)
- **`artifacts/telegram-lambda`** — Lambda A: Telegram webhook → start VMS job
- **`artifacts/vms-webhook-lambda`** — Lambda B: VMS completion webhook → deliver
- **`artifacts/api-server`** — local dev runner (same core, in-memory, inline poll)
- **`lib/db`** — Drizzle schema (`users`, `jobs`) + optional `repo.ts`
- **`template.yaml`** — AWS SAM infra. **`DEPLOY.md`** — the deploy runbook.

## Architecture decisions

- **Webhook chain, not polling.** Video jobs run minutes; a Lambda can't wait.
  Lambda A starts the job with a `webhookUrl` and returns in <1s; VMS calls
  Lambda B when done. No Lambda ever blocks on a long job.
- **One pure core, two hosts.** All logic lives in `lib/bot-core` and is unit-
  tested without Telegram or AWS. Lambda and the local runner are thin adapters.
- **Stateless-safe state.** Sessions, the per-user job lock, and `jobId→chatId`
  all live in DynamoDB with TTL, so multiple Lambda instances stay consistent.
- **Defense in depth.** Telegram `secret_token` on Lambda A; HMAC-SHA256
  signature check on the VMS webhook in Lambda B.
- **DB is optional.** `lib/db/repo.ts` no-ops without `DATABASE_URL`, so the bot
  runs with or without a database.

## Gotchas

- **Secrets:** `.env` is local-only and gitignored — never commit it. For AWS,
  secrets live in SSM Parameter Store (see `DEPLOY.md`).
- **Windows build:** `pnpm-workspace.yaml` keeps `win32-x64` esbuild/rollup
  binaries (we build on Windows) alongside `linux-x64` (for the Lambda bundle).
- **AWS SDK is externalized** in the Lambda bundles — provided by the runtime.
  Don't add it to a bundle; import only inside Lambda code.

## Product

Five thin wrappers over VMS, each a guided step-by-step flow:
🎬 Best Clips · ✂️ Clip Cut · 📝 Subtitles · ⏱ Timestamps · ⬇️ Download.
`/start` `/help` `/history` `/cancel`.
