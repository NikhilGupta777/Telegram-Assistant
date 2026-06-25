import { Telegraf, Markup } from "telegraf";
import type { Context } from "telegraf";
import {
  handleText,
  handleDownloadChoice,
  startFeature,
  type FlowAction,
  type Keyboard,
  type SessionState,
} from "./flow.js";
import type { Feature } from "./format.js";
import { chunkMessage, esc, isYouTubeUrl, fmtTime, shortYoutubeLabel } from "./format.js";
import {
  startJob,
  cancelJob,
  type JobEnvelope,
  type StartJobOptions,
} from "./vms.js";
import type { SessionStore, JobStore, JobMapping } from "./store.js";
import { WELCOME, HELP } from "./text.js";
import { MAIN_MENU, retryKb } from "./keyboards.js";

// ─── Keyboards ───────────────────────────────────────────────────────────────

const CANCEL_KB = Markup.inlineKeyboard([
  [Markup.button.callback("❌ Cancel", "cancel")],
]);

const DOWNLOAD_TYPE_KB = Markup.inlineKeyboard([
  [
    Markup.button.callback("🎬 Full Video (MP4)", "dl:video"),
    Markup.button.callback("🎵 Audio Only (MP3)", "dl:audio"),
  ],
  [Markup.button.callback("❌ Cancel", "cancel")],
]);

export { MAIN_MENU, retryKb };

function kb(keyboard: Keyboard | undefined) {
  switch (keyboard) {
    case "cancel":
      return CANCEL_KB;
    case "main":
      return MAIN_MENU;
    case "download_type":
      return DOWNLOAD_TYPE_KB;
    default:
      return undefined;
  }
}

const FEATURE_EMOJI: Record<string, string> = {
  clips: "🎬",
  cut: "✂️",
  subtitles: "📝",
  timestamps: "⏱",
  download: "⬇️",
};

// ─── Bot factory ─────────────────────────────────────────────────────────────

export interface BotDeps {
  sessions: SessionStore;
  jobs: JobStore;
  /**
   * Called when the flow wants to start a VMS job. The impl differs by host:
   *  - local runner: starts the job, then polls and posts the result inline.
   *  - Lambda A: starts the job with a webhookUrl + stores the mapping, returns.
   */
  onStartJob: (
    ctx: Context,
    job: { feature: Feature; endpoint: string; payload: Record<string, unknown> },
  ) => Promise<void>;
  /** Optional: record/lookup users + jobs for /history. No-op if omitted. */
  onSeenUser?: (user: {
    id: number;
    username?: string | undefined;
    firstName?: string | undefined;
  }) => Promise<void>;
  recentJobs?: (userId: number) => Promise<
    {
      feature: string;
      status: string;
      resultUrl?: string | null;
      createdAt: Date;
    }[]
  >;
  allowedUsers?: number[];
  allowedChats?: number[];
}

export function createBot(token: string, deps: BotDeps): Telegraf {
  const bot = new Telegraf(token);
  const { sessions } = deps;

  /**
   * Execute a flow action:
   *  - Persist the new session state.
   *  - Edit the previous bot message in-place when stepping through a multi-step
   *    flow, falling back to a new reply if the edit fails.
   *  - Delete the stale step prompt when the session is being cleared (job start).
   *  - Store botMessageId in the session so the next step can edit it.
   */
  async function runAction(
    ctx: Context,
    userId: number,
    action: FlowAction,
    currentSession?: SessionState,
  ) {
    const chatId = ctx.chat!.id;
    const prevBotMsgId = currentSession?.botMessageId;

    // Persist session first so the message_id patch below lands on a live record.
    if (action.session === null) {
      await sessions.clear(userId);
    } else if (action.session) {
      await sessions.clear(userId);
      await sessions.set(userId, action.session);
    }

    // When a job is starting (session cleared), remove the stale step prompt
    // so the chat stays clean. The fresh confirmation reply takes its place.
    if (action.session === null && prevBotMsgId) {
      try {
        await ctx.telegram.deleteMessage(chatId, prevBotMsgId);
      } catch {
        // Message may already be gone — harmless.
      }
    }

    for (const r of action.replies) {
      const markup = kb(r.keyboard) ?? {};
      const extra: any = { parse_mode: "HTML", ...markup };
      
      if (r.forceReply) {
        extra.reply_markup = { ...extra.reply_markup, force_reply: true, selective: true };
      }

      // Try to edit the previous prompt when we're mid-flow (not clearing session).
      // ForceReply can only be sent on new messages, not edits.
      const canEdit = !r.forceReply && prevBotMsgId != null && action.session !== null && action.session?.step;
      if (canEdit) {
        try {
          await ctx.telegram.editMessageText(chatId, prevBotMsgId, undefined, r.text, extra);
          // Keep the same message ID for the next step.
          if (action.session?.step) {
            await sessions.set(userId, { botMessageId: prevBotMsgId });
          }
          continue;
        } catch {
          // Edit failed (message too old, identical content, etc.) — fall through.
        }
      }

      const msg = await ctx.reply(r.text, extra);
      // Persist the new message ID so the next step can edit it.
      if (action.session?.step) {
        await sessions.set(userId, { botMessageId: msg.message_id });
      }
    }

    if (action.startJob) {
      await deps.onStartJob(ctx, action.startJob);
    }
  }

  /**
   * Cancel any in-flight VMS job for this user, clean up the lock, and clear
   * the session. Safe to call even when no job is running.
   *
   * Returns the JobMapping rows that were cancelled so the caller can show
   * the user what they killed (e.g. "✂️ Cut (0:01 → 0:08) — youtu.be/abc")
   * instead of a bare "Cancelled" with no detail.
   */
  async function cancelUserJob(userId: number): Promise<JobMapping[]> {
    const cancelled: JobMapping[] = [];
    const activeJobIdsStr = await deps.jobs.getActiveJobId(userId);
    if (activeJobIdsStr) {
      const activeJobIds = activeJobIdsStr.split(",").filter((s) => s);
      for (const jobId of activeJobIds) {
        // Capture the mapping BEFORE delete so we can describe it to the user.
        const mapping = await deps.jobs.getJob(jobId).catch(() => null);
        if (mapping) cancelled.push(mapping);
        // Best-effort: VMS may not support cancellation for all endpoints.
        void cancelJob(jobId).catch(() => {});
        await deps.jobs.delete(jobId).catch(() => {});
      }
    }
    // Always release the lock (concurrency / rate limiter state) and clear session.
    await deps.jobs.unlock(userId).catch(() => {});
    await sessions.clear(userId);
    return cancelled;
  }

  /** Build a one-line description of a cancelled job for the /cancel reply. */
  function describeCancelled(m: JobMapping): string {
    const emoji = FEATURE_EMOJI[m.feature] ?? "•";
    let range = "";
    const start = m.payload?.["startTime"];
    const end = m.payload?.["endTime"];
    if (typeof start === "number" && typeof end === "number") {
      range = ` (${fmtTime(start)} → ${fmtTime(end)})`;
    }
    const url = typeof m.payload?.["url"] === "string" ? (m.payload["url"] as string) : "";
    const link = url ? ` — <a href="${esc(url)}">${esc(shortYoutubeLabel(url))}</a>` : "";
    return `${emoji} <b>${m.feature}</b>${range}${link}`;
  }

  /** Build the user-facing reply for /cancel / ❌ Cancel. */
  function cancelReply(cancelled: JobMapping[]): string {
    if (cancelled.length === 0) return "✅ <b>Nothing to cancel.</b>";
    if (cancelled.length === 1)
      return `✅ <b>Cancelled:</b>\n${describeCancelled(cancelled[0]!)}`;
    return (
      `✅ <b>Cancelled ${cancelled.length} jobs:</b>\n` +
      cancelled.map(describeCancelled).join("\n")
    );
  }

  // ── Access Control ──
  const { allowedUsers, allowedChats } = deps;
  if ((allowedUsers && allowedUsers.length > 0) || (allowedChats && allowedChats.length > 0)) {
    bot.use(async (ctx, next) => {
      const userId = ctx.from?.id;
      const chatId = ctx.chat?.id;
      const chatType = ctx.chat?.type;

      const userAllowed = userId && allowedUsers?.includes(userId);
      const chatAllowed = chatId && allowedChats?.includes(chatId);

      if (!userAllowed && !chatAllowed) {
        // Only reply with unauthorized in private chats to avoid spamming groups
        if (chatType === "private") {
          await ctx.reply("⛔️ Unauthorized. This bot is private.");
        }
        return;
      }
      return next();
    });
  }

  // Track every interacting user FIRST (best-effort, non-blocking), so it runs
  // even for commands like /start whose handlers don't call next().
  if (deps.onSeenUser) {
    bot.use(async (ctx, next) => {
      if (ctx.from) {
        void deps
          .onSeenUser!({
            id: ctx.from.id,
            username: ctx.from.username,
            firstName: ctx.from.first_name,
          })
          .catch(() => {});
      }
      return next();
    });
  }

  // ── Commands ──
  bot.start(async (ctx) => {
    await cancelUserJob(ctx.from.id);
    await ctx.reply(WELCOME, { parse_mode: "HTML", ...MAIN_MENU });
  });

  bot.help(async (ctx) => {
    await ctx.reply(HELP, { parse_mode: "HTML", ...MAIN_MENU });
  });

  bot.command("cancel", async (ctx) => {
    const cancelled = await cancelUserJob(ctx.from.id);
    await ctx.reply(cancelReply(cancelled), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...MAIN_MENU,
    });
  });



  bot.command("history", async (ctx) => {
    if (!deps.recentJobs) {
      await ctx.reply(
        "🕘 History isn't available right now.",
        { parse_mode: "HTML", ...MAIN_MENU },
      );
      return;
    }
    const rows = await deps.recentJobs(ctx.from.id);
    if (rows.length === 0) {
      await ctx.reply(
        "🕘 <b>No recent jobs yet.</b>\n\nPick a feature to get started!",
        { parse_mode: "HTML", ...MAIN_MENU },
      );
      return;
    }
    const statusIcon: Record<string, string> = {
      done: "✅",
      error: "❌",
      failed: "❌",
      cancelled: "🚫",
      running: "⏳",
      pending: "⏳",
      queued: "⏳",
    };
    const lines = rows.map((r) => {
      const when = r.createdAt.toISOString().slice(0, 16).replace("T", " ");
      const link = r.resultUrl
        ? ` — <a href="${esc(r.resultUrl)}">link</a>`
        : "";
      return `${FEATURE_EMOJI[r.feature] ?? "•"} <b>${r.feature}</b> ${statusIcon[r.status] ?? ""} <i>${when}</i>${link}`;
    });
    await ctx.reply(`🕘 <b>Your recent jobs</b>\n\n${lines.join("\n")}`, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...MAIN_MENU,
    });
  });

  // ── Menu actions ──
  bot.action("menu", async (ctx) => {
    await ctx.answerCbQuery();
    await cancelUserJob(ctx.from!.id);
    await ctx.reply(WELCOME, { parse_mode: "HTML", ...MAIN_MENU });
  });

  bot.action("cancel", async (ctx) => {
    await ctx.answerCbQuery("Cancelled ✅");
    const cancelled = await cancelUserJob(ctx.from!.id);
    await ctx.reply(cancelReply(cancelled), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...MAIN_MENU,
    });
  });

  // ── Feature buttons & commands ──
  // IMPORTANT: opening a wizard must NOT cancel the user's in-flight VMS jobs.
  // Re-issuing /download (or tapping a feature button) used to call
  // cancelUserJob() — which invoked VMS /jobs/:id/cancel on every active job
  // for that user and killed legitimate in-flight work, surfacing as
  // "❌ Cancelled by user" messages the user never asked for. Now we only
  // clear the session (wizard state); the user's running jobs continue,
  // and /cancel + ❌ Cancel + /start + 🏠 Main Menu remain the explicit
  // "kill everything" entry points.
  for (const feature of ["clips", "cut", "subtitles", "timestamps", "download"] as const) {
    bot.action(`feat:${feature}`, async (ctx) => {
      await ctx.answerCbQuery();
      await sessions.clear(ctx.from!.id);
      await runAction(ctx, ctx.from!.id, startFeature(feature));
    });

    if (feature !== "clips") {
      bot.command(feature, async (ctx) => {
        await sessions.clear(ctx.from.id);
        await runAction(ctx, ctx.from.id, startFeature(feature));
      });
    }
  }



  // ── Download type buttons ──
  bot.action("dl:video", async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from!.id;
    const session = await sessions.get(userId);
    await runAction(ctx, userId, handleDownloadChoice(session, false), session);
  });
  bot.action("dl:audio", async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from!.id;
    const session = await sessions.get(userId);
    await runAction(ctx, userId, handleDownloadChoice(session, true), session);
  });

  // ── Text ──
  bot.on("text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) return; // commands handled above
    const userId = ctx.from.id;
    const session = await sessions.get(userId);

    // In a group, only respond if there's an active session or it's a reply to the bot
    if (
      ctx.chat.type !== "private" &&
      !session?.step &&
      ctx.message.reply_to_message?.from?.id !== ctx.botInfo.id
    ) {
      return;
    }

    await runAction(ctx, userId, handleText(session, text), session);
  });

  // ── Non-text media (photos, voice, stickers, etc.) ──
  bot.on(
    ["photo", "document", "voice", "sticker", "video", "audio", "animation", "contact", "location"],
    async (ctx) => {
      if (ctx.chat.type !== "private") return; // Don't spam groups with error messages
      await ctx.reply(
        "👇 I only work with YouTube links — choose a feature and paste your link:",
        { parse_mode: "HTML", ...MAIN_MENU },
      );
    },
  );

  bot.catch((err) => {
    // Adapters wire their own logger; rethrow-safe no-op here.
    console.error("Telegraf error", err);
  });

  return bot;
}

// ─── Helpers reused by both hosts when delivering a finished job ─────────────

export async function startJobForChat(
  feature: Feature,
  endpoint: string,
  payload: Record<string, unknown>,
  ctx: { chatId: number; userId: number; statusMessageId?: number; username?: string },
  jobs: JobStore,
  opts: StartJobOptions,
): Promise<JobEnvelope> {
  const job = await startJob(endpoint, payload, opts);
  const mapping: JobMapping = {
    jobId: job.jobId,
    chatId: ctx.chatId,
    userId: ctx.userId,
    username: ctx.username,
    payload,
    feature,
    ...(ctx.statusMessageId !== undefined
      ? { statusMessageId: ctx.statusMessageId }
      : {}),
    createdAt: Date.now(),
  };
  await jobs.put(mapping);
  return job;
}

export { chunkMessage, FEATURE_EMOJI };
export { deliverResult } from "./deliver.js";
