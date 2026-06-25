import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { Telegram } from "telegraf";
import type { Telegraf } from "telegraf";
import type { Context } from "telegraf";
import {
  createBot,
  retryKb,
  startJobForChat,
  deliverResult,
  FEATURE_EMOJI,
} from "@workspace/bot-core/telegram";
import { loadConfigFromSsm } from "@workspace/bot-core/config";
import { DynamoStore } from "@workspace/bot-core/dynamo";
import {
  VmsError,
  friendlyError,
  isTerminal,
  isSucceeded,
  pollJob,
  runJobPoller,
  type BotPollerEvent,
  formatJobStart,
} from "@workspace/bot-core";
import { upsertUser, recordJobStart, recentJobs, recordJobFinish } from "@workspace/db/repo";

// ─── Self-invoke config ─────────────────────────────────────────────────────
// The poller runs as a separate async invocation of THIS same function so its
// lifecycle is independent of the response Lambda — meaning VMS's variable
// webhook delivery latency no longer determines how fast the user sees the
// result. Polling typically wins the race against the webhook by 30s-3min.
const SELF_FUNCTION_NAME =
  process.env["BOT_POLLER_FUNCTION_NAME"] ??
  process.env["AWS_LAMBDA_FUNCTION_NAME"] ??
  "";
const REGION =
  process.env["AWS_REGION"] ?? process.env["AWS_DEFAULT_REGION"] ?? "us-east-1";
const lambdaClient =
  SELF_FUNCTION_NAME && process.env["AWS_LAMBDA_FUNCTION_NAME"]
    ? new LambdaClient({ region: REGION })
    : null;

// ─── Warm-container singletons ──────────────────────────────────────────────
let botPromise:
  | Promise<{
      bot: Telegraf;
      webhookSecret: string;
      store: DynamoStore;
      telegram: Telegram;
    }>
  | undefined;

async function getBot() {
  if (botPromise) return botPromise;
  botPromise = (async () => {
    const cfg = await loadConfigFromSsm();
    const tableName = cfg.tableName ?? process.env["TABLE_NAME"]!;
    const store = new DynamoStore(tableName);
    const telegram = new Telegram(cfg.telegramBotToken);

    if (!cfg.telegramWebhookSecret) {
      console.warn(
        "[telegram-lambda] TELEGRAM_WEBHOOK_SECRET is empty — incoming update " +
          "verification is DISABLED; the function URL will accept spoofed updates.",
      );
    }

    // The VMS webhook base URL points at Lambda B's Function URL.
    const vmsWebhookUrl = cfg.vmsWebhookBaseUrl;

    const bot = createBot(cfg.telegramBotToken, {
      allowedUsers: cfg.allowedUsers,
      allowedChats: cfg.allowedChats,
      sessions: store,
      jobs: store,
      onSeenUser: upsertUser,
      recentJobs,
      onStartJob: async (ctx: Context, job) => {
        const userId = ctx.from!.id;
        const chatId = ctx.chat!.id;

        // Rate limit check: max 15 clip cuts/downloads every 3 minutes.
        const allowed = await store.tryLock(userId);
        if (!allowed) {
          await ctx.reply(
            `⚠️ <b>Rate limit exceeded</b>\n\nYou can submit up to 15 clip cuts/downloads every 3 minutes. Please wait a moment before trying again.`,
            { parse_mode: "HTML" },
          );
          return;
        }

        try {
          // Deterministic idempotency key: same user+payload within a short
          // window won't double-fire if Telegram retries the update.
          const idempotencyKey = `${userId}:${job.endpoint}:${JSON.stringify(
            job.payload,
          )}`.slice(0, 200);

          const prefix = formatJobStart(job.feature, job.payload);
          const status = await ctx.reply(
            prefix,
            { parse_mode: "HTML" },
          );

          const started = await startJobForChat(
            job.feature,
            job.endpoint,
            job.payload,
            {
              chatId,
              userId,
              statusMessageId: status.message_id,
              username: ctx.from?.username ?? ctx.from?.first_name,
            },
            store,
            {
              ...(vmsWebhookUrl ? { webhookUrl: vmsWebhookUrl } : {}),
              idempotencyKey,
            },
          );

          // Record the jobId in the lock so /cancel can terminate the VMS job.
          await store.setLockJob(userId, started.jobId);

          await recordJobStart({
            id: started.jobId,
            userId,
            chatId,
            feature: job.feature,
          });

          // Idempotency replay or already-terminal job: VMS won't fire the
          // webhook again, so deliver inline if the job is done now. We
          // race the markDelivered claim so we don't double-send if a
          // late webhook also arrives.
          if (started.replayed || isTerminal(started)) {
            const current = await pollJob(started.jobId).catch(() => started);
            if (isTerminal(current)) {
              const won = await store.markDelivered(started.jobId);
              if (won) {
                try {
                  current.terminal = true;
                  await deliverResult(ctx.telegram, chatId, job.feature, current, {
                    statusMessageId: status.message_id,
                  });
                } finally {
                  await recordJobFinish({
                    id: started.jobId,
                    status: current.status,
                    resultUrl: pickUrl(current.result),
                    ...(current.message ? { errorMessage: current.message } : {}),
                  }).catch(() => {});
                  await store.delete(started.jobId).catch(() => {});
                  await store.unlock(userId, started.jobId);
                }
              } else {
                // Webhook already won — just release the lock.
                await store.delete(started.jobId).catch(() => {});
                await store.unlock(userId, started.jobId);
              }
              return;
            }
          }

          // Fresh job (or replay of a still-running one): self-invoke this
          // Lambda as a poller. The poller polls VMS every ~3s and races
          // the webhook to deliver — both go through markDelivered so the
          // user gets exactly one message no matter who wins.
          if (lambdaClient && SELF_FUNCTION_NAME) {
            const payload: BotPollerEvent = {
              source: "bot.poll",
              jobId: started.jobId,
              chatId,
              userId,
              feature: job.feature,
              ...(status.message_id !== undefined
                ? { statusMessageId: status.message_id }
                : {}),
            };
            await lambdaClient
              .send(
                new InvokeCommand({
                  FunctionName: SELF_FUNCTION_NAME,
                  InvocationType: "Event",
                  Payload: Buffer.from(JSON.stringify(payload)),
                }),
              )
              .catch((err: unknown) => {
                console.warn("Failed to dispatch poller; falling back to webhook only", err);
              });
          }
        } catch (err) {
          await store.unlock(userId);
          const emoji = FEATURE_EMOJI[job.feature] ?? "";
          const friendly =
            err instanceof VmsError
              ? friendlyError(err.code, err.message)
              : `${emoji} <b>Failed to start job.</b> Please try again.`;
          await ctx.reply(friendly, {
            parse_mode: "HTML",
            ...retryKb(job.feature),
          });
        }
      },
    });

    return { bot, webhookSecret: cfg.telegramWebhookSecret, store, telegram };
  })();
  // Don't cache a rejected init on the warm container — a transient SSM/DDB
  // failure would otherwise poison every subsequent invocation until recycle.
  botPromise.catch(() => {
    botPromise = undefined;
  });
  return botPromise;
}

function pickUrl(result?: Record<string, unknown>): string | undefined {
  if (!result) return undefined;
  return (result["url"] ?? result["downloadUrl"] ?? result["fileUrl"]) as
    | string
    | undefined;
}

// ─── Handler: dispatch on event shape ───────────────────────────────────────
//   - HTTP event from Telegram → run the bot
//   - { source: "bot.poll", ... } → run the poller (self-invoked)
function isHttpEvent(event: unknown): event is APIGatewayProxyEventV2 {
  const e = event as Partial<APIGatewayProxyEventV2> | null;
  return !!e && (e.requestContext?.http?.method !== undefined || typeof e.rawPath === "string");
}

export async function handler(
  event: APIGatewayProxyEventV2 | BotPollerEvent,
): Promise<APIGatewayProxyResultV2 | void> {
  // ── Poller branch ─────────────────────────────────────────────────────────
  if (!isHttpEvent(event) && (event as BotPollerEvent).source === "bot.poll") {
    const e = event as BotPollerEvent;
    const { telegram, store } = await getBot();
    await runJobPoller(
      {
        telegram,
        jobs: store,
        onDelivered: async (jobId, _userId, job) => {
          // Record the REAL terminal status + result URL (not a hardcoded
          // "done") so /history reflects failures correctly.
          await recordJobFinish({
            id: jobId,
            status: job.status || (isSucceeded(job) ? "done" : "error"),
            resultUrl: pickUrl(job.result),
            ...(job.message ? { errorMessage: job.message } : {}),
          }).catch(() => {});
        },
      },
      e,
    );
    return;
  }

  // ── Standard HTTP branch (Telegram webhook update) ────────────────────────
  const httpEvent = event as APIGatewayProxyEventV2;
  const { bot, webhookSecret } = await getBot();

  // Verify Telegram's secret token header to reject spoofed updates.
  if (webhookSecret) {
    const provided =
      httpEvent.headers?.["x-telegram-bot-api-secret-token"] ??
      httpEvent.headers?.["X-Telegram-Bot-Api-Secret-Token"];
    if (provided !== webhookSecret) {
      return { statusCode: 401, body: "unauthorized" };
    }
  }

  let update: unknown;
  try {
    const body = httpEvent.isBase64Encoded
      ? Buffer.from(httpEvent.body ?? "", "base64").toString("utf-8")
      : httpEvent.body ?? "";
    update = JSON.parse(body);
  } catch {
    return { statusCode: 400, body: "bad request" };
  }

  try {
    await bot.handleUpdate(update as Parameters<typeof bot.handleUpdate>[0]);
  } catch (err) {
    console.error("handleUpdate failed", err);
    // Still return 200 so Telegram doesn't spam retries for a poison update.
  }
  return { statusCode: 200, body: "ok" };
}
