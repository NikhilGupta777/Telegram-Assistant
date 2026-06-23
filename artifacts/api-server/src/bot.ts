import { Telegraf, Markup } from "telegraf";
import { logger } from "./lib/logger.js";
import { startJob, waitForJob, type JobEnvelope } from "./lib/vms.js";

const token = process.env["TELEGRAM_BOT_TOKEN"];
if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");

export const bot = new Telegraf(token);

type Feature =
  | "clips"
  | "cut"
  | "subtitles"
  | "timestamps"
  | "download"
  | "bhagwat"
  | "thumbnail"
  | "agent"
  | "uploads";

interface SessionState {
  feature?: Feature;
  step?: string;
  data?: Record<string, unknown>;
}

const sessions = new Map<number, SessionState>();

function getSession(userId: number): SessionState {
  if (!sessions.has(userId)) sessions.set(userId, {});
  return sessions.get(userId)!;
}

function clearSession(userId: number) {
  sessions.set(userId, {});
}

const MAIN_MENU = Markup.inlineKeyboard([
  [
    Markup.button.callback("🎬 Best Clips", "feat:clips"),
    Markup.button.callback("✂️ Clip Cut", "feat:cut"),
  ],
  [
    Markup.button.callback("📝 Subtitles", "feat:subtitles"),
    Markup.button.callback("⏱ Timestamps", "feat:timestamps"),
  ],
  [
    Markup.button.callback("⬇️ Download", "feat:download"),
    Markup.button.callback("📖 Bhagwat AI", "feat:bhagwat"),
  ],
  [
    Markup.button.callback("🖼 Thumbnail", "feat:thumbnail"),
    Markup.button.callback("🤖 AI Copilot", "feat:agent"),
  ],
  [Markup.button.callback("☁️ Uploads & Sharing", "feat:uploads")],
]);

const CANCEL_MENU = Markup.inlineKeyboard([
  [Markup.button.callback("❌ Cancel", "cancel")],
  [Markup.button.callback("🏠 Main Menu", "menu")],
]);

function formatResult(job: JobEnvelope, feature: Feature): string {
  if (!job.succeeded && job.status !== "done") {
    return `❌ Job failed: ${job.message ?? "Unknown error"}`;
  }

  const result = job.result ?? {};

  switch (feature) {
    case "clips": {
      const clips = (result["clips"] ?? result["ideas"] ?? result["data"]) as
        | Array<{
            title?: string;
            start?: number;
            end?: number;
            startTime?: number;
            endTime?: number;
            duration?: number;
            reason?: string;
            description?: string;
          }>
        | undefined;
      if (Array.isArray(clips) && clips.length > 0) {
        const lines = clips.map((c, i) => {
          const start = c.start ?? c.startTime ?? 0;
          const end = c.end ?? c.endTime ?? 0;
          return `${i + 1}. *${c.title ?? "Clip"}*\n   🕐 ${fmtTime(start)} → ${fmtTime(end)}\n   ${c.reason ?? c.description ?? ""}`;
        });
        return `🎬 *AI Best Clips*\n\n${lines.join("\n\n")}`;
      }
      return `🎬 *Clips Result*\n\`\`\`\n${JSON.stringify(result, null, 2)}\n\`\`\``;
    }

    case "cut": {
      const url = (result["url"] ?? result["downloadUrl"]) as string | undefined;
      if (url) return `✂️ *Clip Ready!*\n\n[⬇️ Download your clip](${url})`;
      return `✂️ Done!\n\`\`\`\n${JSON.stringify(result, null, 2)}\n\`\`\``;
    }

    case "download": {
      const url = (result["url"] ?? result["downloadUrl"]) as string | undefined;
      if (url) return `⬇️ *Download Ready!*\n\n[⬇️ Click to download](${url})`;
      return `⬇️ Done!\n\`\`\`\n${JSON.stringify(result, null, 2)}\n\`\`\``;
    }

    case "subtitles": {
      const srt = result["srt"] as string | undefined;
      const text = result["text"] as string | undefined;
      if (srt) {
        const preview = srt.length > 800 ? srt.slice(0, 800) + "\n..." : srt;
        return `📝 *Subtitles Generated!*\n\n\`\`\`\n${preview}\n\`\`\``;
      }
      if (text) {
        const preview = text.length > 800 ? text.slice(0, 800) + "..." : text;
        return `📝 *Transcript:*\n\n${preview}`;
      }
      return `📝 Done!\n\`\`\`\n${JSON.stringify(result, null, 2)}\n\`\`\``;
    }

    case "timestamps": {
      const ts = (result["timestamps"] ?? result["chapters"]) as
        | Array<{ time?: number; label?: string; title?: string }>
        | undefined;
      if (Array.isArray(ts) && ts.length > 0) {
        const lines = ts.map(
          (t) => `${fmtTime(t.time ?? 0)} — ${t.label ?? t.title ?? ""}`,
        );
        return `⏱ *AI Timestamps*\n\n${lines.join("\n")}`;
      }
      return `⏱ Done!\n\`\`\`\n${JSON.stringify(result, null, 2)}\n\`\`\``;
    }

    case "bhagwat": {
      const url = (result["url"] ?? result["downloadUrl"]) as string | undefined;
      const text = result["text"] as string | undefined;
      if (url) return `📖 *Bhagwat AI Result*\n\n[📥 Download](${url})`;
      if (text) return `📖 *Bhagwat AI Result*\n\n${text.slice(0, 1000)}`;
      return `📖 Done!\n\`\`\`\n${JSON.stringify(result, null, 2)}\n\`\`\``;
    }

    case "thumbnail": {
      const url = (result["url"] ?? result["imageUrl"]) as string | undefined;
      if (url) return `__THUMBNAIL__:${url}`;
      return `🖼 Done!\n\`\`\`\n${JSON.stringify(result, null, 2)}\n\`\`\``;
    }

    case "agent": {
      const reply =
        (result["reply"] as string | undefined) ??
        (result["response"] as string | undefined) ??
        (result["text"] as string | undefined);
      if (reply) return `🤖 *AI Copilot:*\n\n${reply}`;
      return `🤖 Done!\n\`\`\`\n${JSON.stringify(result, null, 2)}\n\`\`\``;
    }

    case "uploads": {
      const url = (result["url"] ?? result["shareUrl"]) as string | undefined;
      if (url) return `☁️ *Uploaded!*\n\n[🔗 Share Link](${url})`;
      return `☁️ Done!\n\`\`\`\n${JSON.stringify(result, null, 2)}\n\`\`\``;
    }
  }
}

function fmtTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

async function runJob(
  ctx: { reply: (text: string, extra?: object) => Promise<unknown>; replyWithPhoto?: (url: string, extra?: object) => Promise<unknown> },
  feature: Feature,
  endpoint: string,
  payload: Record<string, unknown>,
) {
  let statusMsg: { message_id?: number } = {};
  try {
    const job = await startJob(endpoint, payload);
    statusMsg = (await ctx.reply(
      `⏳ Job started (ID: \`${job.jobId}\`)\\. Processing…`,
      { parse_mode: "MarkdownV2" },
    )) as { message_id?: number };

    const done = await waitForJob(job.jobId);
    const text = formatResult(done, feature);

    if (text.startsWith("__THUMBNAIL__:")) {
      const url = text.slice("__THUMBNAIL__:".length);
      if (ctx.replyWithPhoto) {
        await ctx.replyWithPhoto(url, {
          caption: "🖼 *Thumbnail Ready\\!*",
          parse_mode: "MarkdownV2",
          ...CANCEL_MENU,
        });
      } else {
        await ctx.reply(`🖼 *Thumbnail Ready\\!*\n[View](${url})`, {
          parse_mode: "MarkdownV2",
          ...CANCEL_MENU,
        });
      }
    } else {
      await ctx.reply(escapeMarkdown(text), {
        parse_mode: "MarkdownV2",
        ...MAIN_MENU,
      });
    }
  } catch (err) {
    logger.error({ err }, "VMS job error");
    await ctx.reply(
      `❌ Error: ${err instanceof Error ? err.message : String(err)}\n\nTry again or pick another feature.`,
      MAIN_MENU,
    );
  }
}

function escapeMarkdown(text: string): string {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

bot.start(async (ctx) => {
  clearSession(ctx.from.id);
  await ctx.reply(
    `👋 Welcome to *VideoMaking Studio Bot*\\!\n\nI can help you with:\n🎬 Best Clips \\| ✂️ Clip Cut \\| 📝 Subtitles \\| ⏱ Timestamps \\| ⬇️ Download \\| 📖 Bhagwat AI \\| 🖼 Thumbnail \\| 🤖 AI Copilot \\| ☁️ Uploads\n\nChoose a feature below:`,
    { parse_mode: "MarkdownV2", ...MAIN_MENU },
  );
});

bot.help(async (ctx) => {
  await ctx.reply(
    `🆘 *Help*\n\nUse the buttons to pick a feature\\.\nSend /start to return to the main menu anytime\\.`,
    { parse_mode: "MarkdownV2", ...MAIN_MENU },
  );
});

bot.action("menu", async (ctx) => {
  await ctx.answerCbQuery();
  clearSession(ctx.from.id);
  await ctx.reply("Choose a feature:", MAIN_MENU);
});

bot.action("cancel", async (ctx) => {
  await ctx.answerCbQuery("Cancelled");
  clearSession(ctx.from.id);
  await ctx.reply("Cancelled. Choose a feature:", MAIN_MENU);
});

const FEATURE_PROMPTS: Record<Feature, string> = {
  clips:
    "🎬 *Best Clips*\n\nSend a YouTube URL and optionally target durations\\.\nFormat: `<url> [30,60]`\nExample:\n`https://youtu.be/abc123 30,60`",
  cut: "✂️ *Clip Cut*\n\nSend:\n`<YouTube URL> <start> <end>`\nTimes in seconds\\.\nExample:\n`https://youtu.be/abc123 10 40`",
  subtitles:
    "📝 *Subtitles*\n\nSend a public video URL:\n`<url> [language]`\nLanguage is optional \\(e\\.g\\. `en`, `hi`\\)\\.\nExample:\n`https://youtu.be/abc123 en`",
  timestamps:
    "⏱ *Timestamps*\n\nSend a YouTube URL:\n`<url> [instructions]`\nExample:\n`https://youtu.be/abc123 Make detailed chapters`",
  download:
    "⬇️ *Download*\n\nSend a YouTube URL:\n`<url> [audio]`\nAdd `audio` to download audio only\\.\nExample:\n`https://youtu.be/abc123`\nor\n`https://youtu.be/abc123 audio`",
  bhagwat:
    "📖 *Bhagwat AI Editor*\n\nSend a public video URL to process with the Bhagwat AI editor:\n`<video url>`",
  thumbnail:
    "🖼 *Thumbnail Studio*\n\nSend a YouTube URL or video URL to generate a thumbnail:\n`<url>`",
  agent:
    "🤖 *AI Studio Copilot*\n\nSend your message or video URL for the AI copilot:\n`<url or message>`",
  uploads:
    "☁️ *Uploads & Sharing*\n\nSend a public file URL to upload and get a share link:\n`<url>`",
};

for (const feat of [
  "clips",
  "cut",
  "subtitles",
  "timestamps",
  "download",
  "bhagwat",
  "thumbnail",
  "agent",
  "uploads",
] as Feature[]) {
  bot.action(`feat:${feat}`, async (ctx) => {
    await ctx.answerCbQuery();
    const session = getSession(ctx.from.id);
    session.feature = feat;
    session.step = "awaiting_input";
    await ctx.reply(FEATURE_PROMPTS[feat], {
      parse_mode: "MarkdownV2",
      ...CANCEL_MENU,
    });
  });
}

bot.on("text", async (ctx) => {
  const userId = ctx.from.id;
  const session = getSession(userId);
  const text = ctx.message.text.trim();

  if (text.startsWith("/")) return;

  if (!session.feature || session.step !== "awaiting_input") {
    await ctx.reply("Choose a feature first:", MAIN_MENU);
    return;
  }

  const feature = session.feature;
  clearSession(userId);

  await ctx.reply("✅ Got it\\! Starting job…", { parse_mode: "MarkdownV2" });

  switch (feature) {
    case "clips": {
      const parts = text.split(/\s+/);
      const url = parts[0];
      const durStr = parts[1];
      const durations = durStr
        ? durStr.split(",").map(Number).filter((n) => !isNaN(n))
        : [30, 60];
      await runJob(ctx, feature, "clips", {
        url,
        durations,
        auto: true,
      });
      break;
    }

    case "cut": {
      const parts = text.split(/\s+/);
      if (parts.length < 3) {
        await ctx.reply(
          "❌ Format: `<url> <startSec> <endSec>`",
          { parse_mode: "MarkdownV2", ...CANCEL_MENU },
        );
        session.feature = feature;
        session.step = "awaiting_input";
        return;
      }
      const [url, startStr, endStr] = parts;
      await runJob(ctx, feature, "clip-cut", {
        url,
        startTime: Number(startStr),
        endTime: Number(endStr),
      });
      break;
    }

    case "subtitles": {
      const parts = text.split(/\s+/);
      const url = parts[0];
      const language = parts[1] ?? "auto";
      await runJob(ctx, feature, "subtitles", { url, language });
      break;
    }

    case "timestamps": {
      const spaceIdx = text.indexOf(" ");
      const url = spaceIdx !== -1 ? text.slice(0, spaceIdx) : text;
      const instructions = spaceIdx !== -1 ? text.slice(spaceIdx + 1) : undefined;
      await runJob(ctx, feature, "timestamps", {
        url,
        ...(instructions ? { instructions } : {}),
      });
      break;
    }

    case "download": {
      const parts = text.split(/\s+/);
      const url = parts[0];
      const audioOnly = parts[1]?.toLowerCase() === "audio";
      await runJob(ctx, feature, "download", { url, audioOnly });
      break;
    }

    case "bhagwat": {
      await runJob(ctx, feature, "bhagwat", { url: text });
      break;
    }

    case "thumbnail": {
      await runJob(ctx, feature, "thumbnail", { url: text });
      break;
    }

    case "agent": {
      const spaceIdx = text.indexOf(" ");
      const isUrl = text.startsWith("http");
      const payload: Record<string, unknown> = isUrl
        ? { url: text }
        : { message: text };
      if (spaceIdx !== -1 && isUrl) {
        payload["instructions"] = text.slice(spaceIdx + 1);
        payload["url"] = text.slice(0, spaceIdx);
      }
      await runJob(ctx, feature, "agent", payload);
      break;
    }

    case "uploads": {
      await runJob(ctx, feature, "uploads", { url: text });
      break;
    }
  }
});

bot.catch((err) => {
  logger.error({ err }, "Telegraf error");
});
