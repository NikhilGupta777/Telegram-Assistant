import { Telegraf, Markup } from "telegraf";
import type { Context } from "telegraf";
import type { InlineKeyboardMarkup } from "telegraf/types";

type InlineKb = Markup.Markup<InlineKeyboardMarkup>;
import {
  handleText,
  handleDownloadChoice,
  startFeature,
  type FlowAction,
  type Keyboard,
  type SessionState,
} from "./flow.js";
import type { Feature } from "./format.js";
import { chunkMessage, esc } from "./format.js";
import {
  startJob,
  type JobEnvelope,
  type StartJobOptions,
} from "./vms.js";
import type { SessionStore, JobStore, JobMapping } from "./store.js";
import { WELCOME, HELP } from "./text.js";

// ─── Keyboards ───────────────────────────────────────────────────────────────

export const MAIN_MENU: InlineKb = Markup.inlineKeyboard([
  [
    Markup.button.callback("🎬 Best Clips", "feat:clips"),
    Markup.button.callback("✂️ Clip Cut", "feat:cut"),
  ],
  [
    Markup.button.callback("📝 Subtitles", "feat:subtitles"),
    Markup.button.callback("⏱ Timestamps", "feat:timestamps"),
  ],
  [Markup.button.callback("⬇️ Download", "feat:download")],
  [
    Markup.button.callback("📖 Bhagwat AI 🔒", "soon"),
    Markup.button.callback("🖼 Thumbnail 🔒", "soon"),
  ],
  [
    Markup.button.callback("🤖 AI Copilot 🔒", "soon"),
    Markup.button.callback("☁️ Uploads 🔒", "soon"),
  ],
]);

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

export function retryKb(feat: Feature): InlineKb {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔄 Try Again", `feat:${feat}`)],
    [Markup.button.callback("🏠 Main Menu", "menu")],
  ]);
}

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
}

export function createBot(token: string, deps: BotDeps): Telegraf {
  const bot = new Telegraf(token);
  const { sessions } = deps;

  async function runAction(ctx: Context, userId: number, action: FlowAction) {
    if (action.session === null) {
      await sessions.clear(userId);
    } else if (action.session) {
      // Replace whole session deterministically.
      await sessions.clear(userId);
      await sessions.set(userId, action.session);
    }
    for (const r of action.replies) {
      const markup = kb(r.keyboard);
      await ctx.reply(r.text, { parse_mode: "HTML", ...(markup ?? {}) });
    }
    if (action.startJob) {
      await deps.onStartJob(ctx, action.startJob);
    }
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
    await sessions.clear(ctx.from.id);
    await ctx.reply(WELCOME, { parse_mode: "HTML", ...MAIN_MENU });
  });

  bot.help(async (ctx) => {
    await ctx.reply(HELP, { parse_mode: "HTML", ...MAIN_MENU });
  });

  bot.command("cancel", async (ctx) => {
    await sessions.clear(ctx.from.id);
    await ctx.reply("✅ Cancelled.", MAIN_MENU);
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
    const icon: Record<string, string> = {
      clips: "🎬",
      cut: "✂️",
      subtitles: "📝",
      timestamps: "⏱",
      download: "⬇️",
    };
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
      return `${icon[r.feature] ?? "•"} <b>${r.feature}</b> ${statusIcon[r.status] ?? ""} <i>${when}</i>${link}`;
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
    await sessions.clear(ctx.from!.id);
    await ctx.reply(WELCOME, { parse_mode: "HTML", ...MAIN_MENU });
  });

  bot.action("cancel", async (ctx) => {
    await ctx.answerCbQuery("Cancelled ✅");
    await sessions.clear(ctx.from!.id);
    await ctx.reply("✅ Cancelled.", MAIN_MENU);
  });

  bot.action("soon", async (ctx) => {
    await ctx.answerCbQuery("🔒 Coming soon! Stay tuned.", { show_alert: true });
  });

  // ── Feature buttons ──
  for (const feature of ["clips", "cut", "subtitles", "timestamps", "download"] as const) {
    bot.action(`feat:${feature}`, async (ctx) => {
      await ctx.answerCbQuery();
      await runAction(ctx, ctx.from!.id, startFeature(feature));
    });
  }

  // ── Download type buttons ──
  bot.action("dl:video", async (ctx) => {
    await ctx.answerCbQuery();
    const session = await sessions.get(ctx.from!.id);
    await runAction(ctx, ctx.from!.id, handleDownloadChoice(session, false));
  });
  bot.action("dl:audio", async (ctx) => {
    await ctx.answerCbQuery();
    const session = await sessions.get(ctx.from!.id);
    await runAction(ctx, ctx.from!.id, handleDownloadChoice(session, true));
  });

  // ── Text ──
  bot.on("text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) return; // commands handled above
    const userId = ctx.from.id;
    const session = await sessions.get(userId);
    await runAction(ctx, userId, handleText(session, text));
  });

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
  ctx: { chatId: number; userId: number; statusMessageId?: number },
  jobs: JobStore,
  opts: StartJobOptions,
): Promise<JobEnvelope> {
  const job = await startJob(endpoint, payload, opts);
  const mapping: JobMapping = {
    jobId: job.jobId,
    chatId: ctx.chatId,
    userId: ctx.userId,
    feature,
    ...(ctx.statusMessageId !== undefined
      ? { statusMessageId: ctx.statusMessageId }
      : {}),
    createdAt: Date.now(),
  };
  await jobs.put(mapping);
  return job;
}

export { chunkMessage };
export { deliverResult } from "./deliver.js";
