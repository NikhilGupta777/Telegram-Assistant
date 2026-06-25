# Deploying the bot to AWS

Architecture: **Lambda A** (Telegram webhook) starts VMS jobs and stores
state in **DynamoDB** using atomic String Sets for bulletproof locks and rate limiting.
Lambda A also triggers an asynchronous self-invoke (the **Lambda Poller**) with exponential backoff.
This poller races against **Lambda B** (which receives the VMS completion webhook) to deliver the result.
DynamoDB's `attribute_not_exists` condition guarantees exactly-once delivery to the chat.
Secrets live in **SSM Parameter Store**. Both Lambdas are exposed via **Function URLs**. 
Cost ≈ $0/month for personal use (Lambda + DynamoDB + SSM free tiers).

```
Telegram ──▶ Lambda A ──▶ VMS API ──(webhook)──▶ Lambda B ──▶ Telegram
                │  │                                 ▲          ▲
                │  └─────(async self-invoke)─────────┤          │
                │             [Lambda Poller]        │          │
                └────────── DynamoDB (Atomic Locks) ─┴──────────┘
```

## Prerequisites

- AWS CLI + [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html), authenticated (`aws configure`).
- Node 22 + pnpm (`pnpm install` already run).
- Your Telegram bot token and VMS API key (the local `.env` values are fine —
  they were never committed to git).

## 1. Gather the secrets

- **Telegram bot token** from [@BotFather](https://t.me/BotFather) (or `/revoke` to rotate if you want a fresh one).
- **VMS API key** (`vms_live_…`) from the developer panel.
- Pick two random strings you invent:
  - `TELEGRAM_WEBHOOK_SECRET` (Telegram echoes it back so we reject spoofed updates)
  - `VMS_WEBHOOK_SECRET` (must match the webhook signing secret configured in VMS)

## 2. Put secrets in SSM Parameter Store

```bash
aws ssm put-parameter --name /bot/telegram-bot-token     --type SecureString --value 'NEW_TELEGRAM_TOKEN'
aws ssm put-parameter --name /bot/telegram-webhook-secret --type SecureString --value 'YOUR_TG_WEBHOOK_SECRET'
aws ssm put-parameter --name /bot/vms-api-key             --type SecureString --value 'NEW_VMS_KEY'
aws ssm put-parameter --name /bot/vms-webhook-secret      --type SecureString --value 'YOUR_VMS_WEBHOOK_SECRET'
```

(Re-run with `--overwrite` to update an existing value.)

## 3. Build the Lambda bundles + deploy

```bash
# First time: guided (creates samconfig.toml)
pnpm -r --filter "./artifacts/telegram-lambda" --filter "./artifacts/vms-webhook-lambda" run build
sam deploy --guided

# Subsequent deploys
pnpm run deploy
```

Optional: pass a Postgres URL to enable `/history`:

```bash
sam deploy --parameter-overrides DatabaseUrl='postgres://…'
```

> If your Postgres is private (not publicly reachable), the Lambdas need VPC
> config + a NAT path; otherwise leave `DatabaseUrl` blank and the bot runs
> fine without history.

After deploy, note the two stack **Outputs**: `TelegramWebhookUrl` and
`VmsWebhookUrl`. (Lambda A already gets `VmsWebhookUrl` injected automatically.)

## 4. Point Telegram at Lambda A

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

## 5. Tell VMS where to call back

The bot already passes `webhookUrl=<VmsWebhookUrl>` on every job it starts, so
VMS will POST completions to Lambda B. Just make sure the **webhook signing
secret** in the VMS developer panel matches `/bot/vms-webhook-secret`.

## 6. Verify

- Message your bot `/start` → you should get the menu.
- Run a quick job (e.g. Timestamps on a short video). Lambda A replies
  "Job started"; when VMS finishes, Lambda B posts the result.
- Logs: `sam logs --stack-name <stack> --tail` (or per function in CloudWatch).

## Auto-deploy from GitHub (CI/CD) — already wired up

`.github/workflows/deploy.yml` deploys to AWS on every push to `main`
(typecheck + tests must pass first), then points Telegram at the new URL.

**Keyless — no secrets stored in GitHub.** It authenticates via GitHub OIDC,
assuming an IAM role, and reads the bot token from SSM at deploy time.

Already configured in this repo:
- IAM role `github-actions-narayan-bhakt-deploy` (trusts
  `repo:NikhilGupta777/Telegram-Assistant:*` via the account's GitHub OIDC provider)
- GitHub repo **variables** `AWS_DEPLOY_ROLE_ARN` and `AWS_REGION`

So `git push` to `main` = build → typecheck → test → `sam deploy` → re-point the
Telegram webhook. Nothing else to set.

> To deploy to a different repo/account, recreate the OIDC role with that repo
> in the trust policy's `sub` condition and update `AWS_DEPLOY_ROLE_ARN`.

## Local development (no AWS)

```bash
pnpm --filter @workspace/api-server run dev   # builds + starts on PORT
```

The local runner (`artifacts/api-server`) uses the **same** `bot-core` logic
with an in-memory store and inline polling, behind a tunnel (set
`WEBHOOK_DOMAIN` to an ngrok/cloudflared host). Good for testing the
conversation flow without deploying.

## Tests & typecheck

```bash
pnpm test         # vitest — pure core logic (47 tests)
pnpm run typecheck
```
