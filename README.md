# Telegram Video Assistant Bot

A completely serverless, stateless, and hyper-resilient Telegram Bot designed to interact with the VideoMaking API (VMS). 

This bot allows users to cut clips, extract audio, generate AI timestamps, and create subtitles directly from YouTube URLs inside Telegram.

## 🏗 Architecture

This bot is designed for **$0/month scale-to-zero deployment** using AWS Serverless technologies (Lambda, DynamoDB). It is uniquely resilient against network failures and webhook delays.

```text
Telegram ──▶ Lambda A ──▶ VMS API ──(webhook)──▶ Lambda B ──▶ Telegram
                │  │                                 ▲          ▲
                │  └─────(async self-invoke)─────────┤          │
                │             [Lambda Poller]        │          │
                └────────── DynamoDB (Atomic Locks) ─┴──────────┘
```

- **Exactly-Once Delivery**: Lambda A triggers a VMS job and also spawns a background "Poller". VMS sends a webhook to Lambda B upon completion. The Poller and the Webhook race each other to deliver the final video. DynamoDB uses atomic `attribute_not_exists` locks to guarantee the user receives the video exactly *once*, regardless of who wins the race or if VMS spams duplicate webhooks.
- **Stateless Sessions**: Telegram chat states are stored in DynamoDB. The bot functions entirely without long-running processes.

---

## 🗺 Codebase Map (Where to Make Changes)

This repository is structured as a monorepo using `pnpm` workspaces.

### 1. `lib/bot-core` (The Brains 🧠)
**99% of your code changes will happen here.** This package contains all the pure, host-agnostic logic of the bot.
- `src/flow.ts`: The State Machine. Edit this file to add new commands, change bot replies, or add new steps to a conversation flow (like adding a language picker).
- `src/format.ts`: Edit this to change how the bot formats text, parses time (e.g. `1:30`), or renders emojis.
- `src/telegram.ts`: The Telegraf bot factory. Handles button clicks and text routing.
- `src/store-dynamo.ts`: The DynamoDB schema and queries. Handles atomic locks and rate limiting using String Sets (`SS`).
- `src/vms.ts`: The HTTP client that talks to the VideoMaking API. Includes exponential backoff logic.
- `src/deliver.ts`: The logic that actually sends the final video/document back to Telegram (handling the 50MB file limit fallback).

### 2. `artifacts/api-server` (Local Development 💻)
A simple Express server that runs the bot locally on your machine.
- It uses in-memory polling instead of webhooks.
- **To run locally**: `pnpm --filter @workspace/api-server run dev`

### 3. `artifacts/telegram-lambda` (Production Lambda A 🚀)
The AWS Lambda function that receives updates directly from Telegram.
- Contains the "Self-Invoke" logic that spawns the background poller (`BotPollerEvent`).

### 4. `artifacts/vms-webhook-lambda` (Production Lambda B 🪝)
The AWS Lambda function that receives completions from the VideoMaking API.

---

## 🛠 How to Make Changes

### Scenario: I want to change the bot's reply text
1. Open `lib/bot-core/src/flow.ts`.
2. Locate the `startFeature` or `handleText` function.
3. Modify the `text` property of the `replies` array.
4. Run `pnpm test` to ensure your text change didn't break any conversation unit tests!

### Scenario: I want to add a new VMS Feature
1. Add the feature name to the `Feature` type in `lib/bot-core/src/format.ts`.
2. Add a new starting step in `flow.ts` (e.g., `case "translate"`).
3. Update `lib/bot-core/src/telegram.ts` to map a new Telegram command (e.g., `/translate`) to your feature.
4. The backend webhook and poller will automatically handle the new feature without any extra work!

---

## 🚀 Deployment

Deployment is fully automated via GitHub Actions (`.github/workflows/deploy.yml`). 

Whenever you push to the `main` branch, GitHub Actions will:
1. Run `pnpm run typecheck` to ensure there are no TypeScript errors.
2. Run `pnpm test` to ensure the conversational flows aren't broken.
3. Deploy the Lambdas to AWS using AWS SAM.

For first-time setup instructions (AWS SAM, DynamoDB, SSM Secrets), please read the [DEPLOY.md](./DEPLOY.md) file.
