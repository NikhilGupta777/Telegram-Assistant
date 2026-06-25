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

## 🚀 Deployment & AWS Configuration

This project is deployed using **AWS SAM (Serverless Application Model)**.

### Prerequisites

- AWS CLI + [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html), authenticated (`aws configure`).
- Node 22 + pnpm (`pnpm install` already run).
- Your Telegram bot token and VMS API key.

### 1. Gather the secrets

- **Telegram bot token** from [@BotFather](https://t.me/BotFather).
- **VMS API key** (`vms_live_…`) from the developer panel.
- Pick two random strings you invent:
  - `TELEGRAM_WEBHOOK_SECRET` (Telegram echoes it back so we reject spoofed updates)
  - `VMS_WEBHOOK_SECRET` (must match the webhook signing secret configured in VMS)

### 2. Put secrets in SSM Parameter Store

These are stored securely in AWS Systems Manager Parameter Store.
```bash
aws ssm put-parameter --name /bot/telegram-bot-token     --type SecureString --value 'NEW_TELEGRAM_TOKEN'
aws ssm put-parameter --name /bot/telegram-webhook-secret --type SecureString --value 'YOUR_TG_WEBHOOK_SECRET'
aws ssm put-parameter --name /bot/vms-api-key             --type SecureString --value 'NEW_VMS_KEY'
aws ssm put-parameter --name /bot/vms-webhook-secret      --type SecureString --value 'YOUR_VMS_WEBHOOK_SECRET'
```
*(Re-run with `--overwrite` to update an existing value.)*

### 3. Build the Lambda bundles + Deploy

```bash
# First time: guided (creates samconfig.toml)
pnpm -r --filter "./artifacts/telegram-lambda" --filter "./artifacts/vms-webhook-lambda" run build
sam deploy --guided

# Subsequent deploys
pnpm run deploy
```

> **Optional:** pass a Postgres URL to enable `/history`:
> `sam deploy --parameter-overrides DatabaseUrl='postgres://…'`

After deploy, note the two stack **Outputs**: `TelegramWebhookUrl` and `VmsWebhookUrl`.

### 4. Point Telegram at Lambda A

```bash
TOKEN='NEW_TELEGRAM_TOKEN'
TG_SECRET='YOUR_TG_WEBHOOK_SECRET'
URL='<TelegramWebhookUrl from outputs>'

curl -s "https://api.telegram.org/bot$TOKEN/setWebhook" \
  -d "url=$URL" \
  -d "secret_token=$TG_SECRET" \
  -d "drop_pending_updates=true"

# Register the bot's command menu
curl -s "https://api.telegram.org/bot$TOKEN/setMyCommands" \
  -H 'Content-Type: application/json' \
  -d '{"commands":[
    {"command":"start","description":"🏠 Main menu"},
    {"command":"help","description":"❓ How to use this bot"},
    {"command":"history","description":"🕘 Your recent jobs"},
    {"command":"cancel","description":"❌ Cancel current action"}]}'
```

### 5. Tell VMS where to call back

The bot automatically passes `webhookUrl=<VmsWebhookUrl>` to VMS on every request. Make sure the **webhook signing secret** in the VMS developer panel matches `/bot/vms-webhook-secret`.

---

## 🤖 CI/CD (GitHub Actions)

This project auto-deploys via GitHub Actions (`.github/workflows/deploy.yml`) on every push to `main` (typecheck + tests must pass first).

**Keyless Deployment:** No AWS credentials are stored in GitHub. It authenticates via GitHub OIDC, assuming an IAM role, and reads the bot token from SSM at deploy time.

Already configured in this repo:
- IAM role `github-actions-narayan-bhakt-deploy`
- GitHub repo **variables** `AWS_DEPLOY_ROLE_ARN` and `AWS_REGION`

So `git push` to `main` = build → typecheck → test → `sam deploy` → re-point the Telegram webhook. Nothing else to set!
