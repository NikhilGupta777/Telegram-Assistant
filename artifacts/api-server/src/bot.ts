import { logger } from "./lib/logger.js";
import {
  createBot,
  deliverResult,
  startJobForChat,
  retryKb,
  FEATURE_EMOJI,
} from "@workspace/bot-core/telegram";
import {
  MemorySessionStore,
  MemoryJobStore,
  waitForJob,
  VmsError,
  friendlyError,
  PROGRESS_MSGS,
  type JobEnvelope,
  formatJobStart,
} from "@workspace/bot-core";
import type { Context } from "telegraf";
import {
  upsertUser,
  recordJobStart,
  recordJobFinish,
  recentJobs,
} from "@workspace/db/repo";

const token = process.env["TELEGRAM_BOT_TOKEN"];
if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");

const sessions = new MemorySessionStore();
const jobs = new MemoryJobStore();

export const bot = createBot(token, {
  allowedUsers: process.env["ALLOWED_USERS"] ? process.env["ALLOWED_USERS"].split(',').map(s => Number(s.trim())).filter(n => !isNaN(n)) : undefined,
  allowedChats: process.env["ALLOWED_CHATS"] ? process.env["ALLOWED_CHATS"].split(',').map(s => Number(s.trim())).filter(n => !isNaN(n)) : undefined,
  sessions,
  jobs,
  onSeenUser: upsertUser,
  recentJobs,
  // Local/dev mode: no webhook chain — start the job, poll inline, deliver.
  onStartJob: async (ctx: Context, job) => {
    const userId = ctx.from!.id;
    const chatId = ctx.chat!.id;

    const allowed = await jobs.tryLock(userId);
    if (!allowed) {
      await ctx.reply(
        `⚠️ <b>Rate limit exceeded</b>\n\nYou can submit up to 10 clip cuts/downloads every 3 minutes. Please wait a moment before trying again.`,
        { parse_mode: "HTML" },
      );
      return;
    }

    let statusMessageId: number | undefined;
    let started: any;
    try {
      const prefix = formatJobStart(job.feature, job.payload);
      const status = await ctx.reply(prefix, {
        parse_mode: "HTML",
      });
      statusMessageId = status.message_id;

      started = await startJobForChat(
        job.feature,
        job.endpoint,
        job.payload,
        { chatId, userId, statusMessageId, username: ctx.from?.username ?? ctx.from?.first_name },
        jobs,
        { idempotencyKey: `${userId}:${Date.now()}` },
      );
      // Record which job belongs to the lock so /cancel can stop it.
      await jobs.setLockJob(userId, started.jobId);

      await recordJobStart({
        id: started.jobId,
        userId,
        chatId,
        feature: job.feature,
      });

      let tick = 0;
      const done = await waitForJob(started.jobId, async (current) => {
        const pct = current.progress != null ? ` ${current.progress}%` : "";
        const msg = PROGRESS_MSGS[tick % PROGRESS_MSGS.length]!;
        tick++;
        const prefix = formatJobStart(job.feature, job.payload);
        try {
          await ctx.telegram.editMessageText(
            chatId,
            statusMessageId!,
            undefined,
            `${prefix} (🔄 ${msg}${pct})`,
            { parse_mode: "HTML" },
          );
        } catch {
          /* ignore edit failures */
        }
      });

      await deliverResult(ctx.telegram, chatId, job.feature, done, {
        statusMessageId,
        username: ctx.from?.username ?? ctx.from?.first_name,
        payload: job.payload,
      });
      await recordJobFinish({
        id: started.jobId,
        status: done.status,
        resultUrl: (done.result?.["url"] ??
          done.result?.["downloadUrl"] ??
          done.result?.["fileUrl"]) as string | undefined,
        ...(done.message ? { errorMessage: done.message } : {}),
      });
    } catch (err) {
      logger.error({ err }, "VMS job error");
      if (statusMessageId !== undefined) {
        try {
          await ctx.telegram.deleteMessage(chatId, statusMessageId);
        } catch {
          /* ok */
        }
      }
      const emoji = FEATURE_EMOJI[job.feature] ?? "";
      const friendly =
        err instanceof VmsError
          ? friendlyError(err.code, err.message)
          : `${emoji} <b>Something went wrong</b>\n\n${
              err instanceof Error ? err.message.slice(0, 400) : "Please try again."
            }`;
      await ctx.reply(friendly, { parse_mode: "HTML", ...retryKb(job.feature) });
    } finally {
      await jobs.unlock(userId, started?.jobId);
    }
  },
});
