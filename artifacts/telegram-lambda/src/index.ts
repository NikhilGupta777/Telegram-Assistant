import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { createBot, retryKb, startJobForChat } from "@workspace/bot-core/telegram";
import { loadConfigFromSsm } from "@workspace/bot-core/config";
import { DynamoStore } from "@workspace/bot-core/dynamo";
import { VmsError, friendlyError } from "@workspace/bot-core";
import { upsertUser, recordJobStart, recentJobs } from "@workspace/db/repo";
import type { Telegraf } from "telegraf";
import type { Context } from "telegraf";

// One bot per warm container.
let botPromise: Promise<{ bot: Telegraf; webhookSecret: string }> | undefined;

async function getBot() {
  if (botPromise) return botPromise;
  botPromise = (async () => {
    const cfg = await loadConfigFromSsm();
    const tableName = cfg.tableName ?? process.env["TABLE_NAME"]!;
    const store = new DynamoStore(tableName);

    // The VMS webhook base URL points at Lambda B's Function URL.
    const vmsWebhookUrl = cfg.vmsWebhookBaseUrl;

    const bot = createBot(cfg.telegramBotToken, {
      sessions: store,
      jobs: store,
      onSeenUser: upsertUser,
      recentJobs,
      onStartJob: async (ctx: Context, job) => {
        const userId = ctx.from!.id;
        const chatId = ctx.chat!.id;

        // Per-user concurrency guard.
        const locked = await store.tryLock(userId);
        if (!locked) {
          await ctx.reply(
            "⏳ You already have a job running. Please wait for it to finish.",
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

          const status = await ctx.reply(
            `⏳ <b>Job started!</b>\n\nI'll send you the result as soon as it's ready.`,
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
            },
            store,
            {
              ...(vmsWebhookUrl ? { webhookUrl: vmsWebhookUrl } : {}),
              idempotencyKey,
            },
          );
          await recordJobStart({
            id: started.jobId,
            userId,
            chatId,
            feature: job.feature,
          });
        } catch (err) {
          await store.unlock(userId);
          const friendly =
            err instanceof VmsError
              ? friendlyError(err.code, err.message)
              : "❌ Failed to start job. Please try again.";
          await ctx.reply(friendly, {
            parse_mode: "HTML",
            ...retryKb(job.feature),
          });
        }
      },
    });

    return { bot, webhookSecret: cfg.telegramWebhookSecret };
  })();
  return botPromise;
}

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const { bot, webhookSecret } = await getBot();

  // Verify Telegram's secret token header to reject spoofed updates.
  if (webhookSecret) {
    const provided =
      event.headers?.["x-telegram-bot-api-secret-token"] ??
      event.headers?.["X-Telegram-Bot-Api-Secret-Token"];
    if (provided !== webhookSecret) {
      return { statusCode: 401, body: "unauthorized" };
    }
  }

  let update: unknown;
  try {
    const body = event.isBase64Encoded
      ? Buffer.from(event.body ?? "", "base64").toString("utf-8")
      : event.body ?? "";
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
