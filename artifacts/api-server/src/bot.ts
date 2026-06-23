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

const CANCEL_KB = Markup.inlineKeyboard([
  [Markup.button.callback("❌ Cancel", "cancel")],
  [Markup.button.callback("🏠 Main Menu", "menu")],
]);

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function fmtTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function formatResult(job: JobEnvelope, feature: Feature): { text: string; imageUrl?: string } {
  if (!job.succeeded && job.status !== "done") {
    return { text: `❌ Job failed: ${esc(job.message ?? "Unknown error")}` };
  }

  const result = job.result ?? {};

  switch (feature) {
    case "clips": {
      const clips = (result["clips"] ?? result["ideas"] ?? result["data"]) as
        | Array<{ title?: string; start?: number; end?: number; startTime?: number; endTime?: number; reason?: string; description?: string }>
        | undefined;
      if (Array.isArray(clips) && clips.length > 0) {
        const lines = clips.map((c, i) => {
          const start = c.start ?? c.startTime ?? 0;
          const end = c.end ?? c.endTime ?? 0;
          return `${i + 1}. <b>${esc(c.title ?? "Clip")}</b>\n   🕐 ${fmtTime(start)} → ${fmtTime(end)}\n   ${esc(c.reason ?? c.description ?? "")}`;
        });
        return { text: `🎬 <b>AI Best Clips</b>\n\n${lines.join("\n\n")}` };
      }
      return { text: `🎬 <b>Result</b>\n<pre>${esc(JSON.stringify(result, null, 2))}</pre>` };
    }

    case "cut": {
      const url = (result["url"] ?? result["downloadUrl"]) as string | undefined;
      if (url) return { text: `✂️ <b>Clip Ready!</b>\n\n<a href="${esc(url)}">⬇️ Download your clip</a>` };
      return { text: `✂️ Done!\n<pre>${esc(JSON.stringify(result, null, 2))}</pre>` };
    }

    case "download": {
      const url = (result["url"] ?? result["downloadUrl"]) as string | undefined;
      if (url) return { text: `⬇️ <b>Download Ready!</b>\n\n<a href="${esc(url)}">⬇️ Click to download</a>` };
      return { text: `⬇️ Done!\n<pre>${esc(JSON.stringify(result, null, 2))}</pre>` };
    }

    case "subtitles": {
      const srt = result["srt"] as string | undefined;
      const text = result["text"] as string | undefined;
      if (srt) {
        const preview = srt.length > 800 ? srt.slice(0, 800) + "\n..." : srt;
        return { text: `📝 <b>Subtitles Generated!</b>\n\n<pre>${esc(preview)}</pre>` };
      }
      if (text) {
        const preview = text.length > 800 ? text.slice(0, 800) + "..." : text;
        return { text: `📝 <b>Transcript:</b>\n\n${esc(preview)}` };
      }
      return { text: `📝 Done!\n<pre>${esc(JSON.stringify(result, null, 2))}</pre>` };
    }

    case "timestamps": {
      const ts = (result["timestamps"] ?? result["chapters"]) as
        | Array<{ time?: number; label?: string; title?: string }>
        | undefined;
      if (Array.isArray(ts) && ts.length > 0) {
        const lines = ts.map((t) => `${fmtTime(t.time ?? 0)} — ${esc(t.label ?? t.title ?? "")}`);
        return { text: `⏱ <b>AI Timestamps</b>\n\n${lines.join("\n")}` };
      }
      return { text: `⏱ Done!\n<pre>${esc(JSON.stringify(result, null, 2))}</pre>` };
    }

    case "bhagwat": {
      const url = (result["url"] ?? result["downloadUrl"]) as string | undefined;
      const text = result["text"] as string | undefined;
      if (url) return { text: `📖 <b>Bhagwat AI Result</b>\n\n<a href="${esc(url)}">📥 Download</a>` };
      if (text) return { text: `📖 <b>Bhagwat AI Result</b>\n\n${esc(text.slice(0, 1000))}` };
      return { text: `📖 Done!\n<pre>${esc(JSON.stringify(result, null, 2))}</pre>` };
    }

    case "thumbnail": {
      const url = (result["url"] ?? result["imageUrl"]) as string | undefined;
      if (url) return { text: `🖼 <b>Thumbnail Ready!</b>`, imageUrl: url };
      return { text: `🖼 Done!\n<pre>${esc(JSON.stringify(result, null, 2))}</pre>` };
    }

    case "agent": {
      const reply =
        (result["reply"] as string | undefined) ??
        (result["response"] as string | undefined) ??
        (result["text"] as string | undefined);
      if (reply) return { text: `🤖 <b>AI Copilot:</b>\n\n${esc(reply)}` };
      return { text: `🤖 Done!\n<pre>${esc(JSON.stringify(result, null, 2))}</pre>` };
    }

    case "uploads": {
      const url = (result["url"] ?? result["shareUrl"]) as string | undefined;
      if (url) return { text: `☁️ <b>Uploaded!</b>\n\n<a href="${esc(url)}">🔗 Share Link</a>` };
      return { text: `☁️ Done!\n<pre>${esc(JSON.stringify(result, null, 2))}</pre>` };
    }
  }
}

type BotCtx = Parameters<Parameters<typeof bot.on>[1]>[0];

async function runJob(
  ctx: BotCtx,
  feature: Feature,
  endpoint: string,
  payload: Record<string, unknown>,
) {
  try {
    const job = await startJob(endpoint, payload);
    await ctx.reply(`⏳ Job started (ID: <code>${esc(job.jobId)}</code>). Processing…`, {
      parse_mode: "HTML",
    });

    const done = await waitForJob(job.jobId);
    const { text, imageUrl } = formatResult(done, feature);

    if (imageUrl) {
      await ctx.replyWithPhoto(imageUrl, {
        caption: text,
        parse_mode: "HTML",
        ...MAIN_MENU,
      });
    } else {
      await ctx.reply(text, { parse_mode: "HTML", ...MAIN_MENU });
    }
  } catch (err) {
    logger.error({ err }, "VMS job error");
    await ctx.reply(
      `❌ Error: ${esc(err instanceof Error ? err.message : String(err))}\n\nTry again or pick another feature.`,
      { parse_mode: "HTML", ...MAIN_MENU },
    );
  }
}

const WELCOME = `👋 Welcome to <b>VideoMaking Studio Bot</b>!

I can help you with:
🎬 Best Clips  |  ✂️ Clip Cut  |  📝 Subtitles
⏱ Timestamps  |  ⬇️ Download  |  📖 Bhagwat AI
🖼 Thumbnail  |  🤖 AI Copilot  |  ☁️ Uploads

Choose a feature below:`;

bot.start(async (ctx) => {
  clearSession(ctx.from.id);
  await ctx.reply(WELCOME, { parse_mode: "HTML", ...MAIN_MENU });
});

bot.help(async (ctx) => {
  await ctx.reply(
    "Use the buttons below to pick a feature. Send /start to return to the main menu anytime.",
    MAIN_MENU,
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
  clips: `🎬 <b>Best Clips</b>\n\nSend a YouTube URL (optionally add target durations).\nFormat: <code>&lt;url&gt; [30,60]</code>\nExample:\n<code>https://youtu.be/abc123 30,60</code>`,
  cut: `✂️ <b>Clip Cut</b>\n\nSend:\n<code>&lt;YouTube URL&gt; &lt;startSec&gt; &lt;endSec&gt;</code>\nExample:\n<code>https://youtu.be/abc123 10 40</code>`,
  subtitles: `📝 <b>Subtitles</b>\n\nSend a public video URL:\n<code>&lt;url&gt; [language]</code>\nLanguage is optional (e.g. <code>en</code>, <code>hi</code>).\nExample:\n<code>https://youtu.be/abc123 en</code>`,
  timestamps: `⏱ <b>Timestamps</b>\n\nSend a YouTube URL:\n<code>&lt;url&gt; [instructions]</code>\nExample:\n<code>https://youtu.be/abc123 Make detailed chapters</code>`,
  download: `⬇️ <b>Download</b>\n\nSend a YouTube URL:\n<code>&lt;url&gt; [audio]</code>\nAdd <code>audio</code> to download audio only.\nExample:\n<code>https://youtu.be/abc123</code>`,
  bhagwat: `📖 <b>Bhagwat AI Editor</b>\n\nSend a public video URL:\n<code>&lt;video url&gt;</code>`,
  thumbnail: `🖼 <b>Thumbnail Studio</b>\n\nSend a YouTube URL or video URL:\n<code>&lt;url&gt;</code>`,
  agent: `🤖 <b>AI Studio Copilot</b>\n\nSend your video URL or message:\n<code>&lt;url or message&gt;</code>`,
  uploads: `☁️ <b>Uploads &amp; Sharing</b>\n\nSend a public file URL:\n<code>&lt;url&gt;</code>`,
};

for (const feat of [
  "clips", "cut", "subtitles", "timestamps", "download",
  "bhagwat", "thumbnail", "agent", "uploads",
] as Feature[]) {
  bot.action(`feat:${feat}`, async (ctx) => {
    await ctx.answerCbQuery();
    const session = getSession(ctx.from.id);
    session.feature = feat;
    session.step = "awaiting_input";
    await ctx.reply(FEATURE_PROMPTS[feat], { parse_mode: "HTML", ...CANCEL_KB });
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

  await ctx.reply("✅ Got it! Starting job…");

  switch (feature) {
    case "clips": {
      const parts = text.split(/\s+/);
      const url = parts[0];
      const durStr = parts[1];
      const durations = durStr
        ? durStr.split(",").map(Number).filter((n) => !isNaN(n))
        : [30, 60];
      await runJob(ctx, feature, "clips", { url, durations, auto: true });
      break;
    }

    case "cut": {
      const parts = text.split(/\s+/);
      if (parts.length < 3) {
        await ctx.reply(
          `❌ Format: <code>&lt;url&gt; &lt;startSec&gt; &lt;endSec&gt;</code>`,
          { parse_mode: "HTML", ...CANCEL_KB },
        );
        session.feature = feature;
        session.step = "awaiting_input";
        return;
      }
      await runJob(ctx, feature, "clip-cut", {
        url: parts[0],
        startTime: Number(parts[1]),
        endTime: Number(parts[2]),
      });
      break;
    }

    case "subtitles": {
      const parts = text.split(/\s+/);
      await runJob(ctx, feature, "subtitles", {
        url: parts[0],
        language: parts[1] ?? "auto",
      });
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
      await runJob(ctx, feature, "download", {
        url: parts[0],
        audioOnly: parts[1]?.toLowerCase() === "audio",
      });
      break;
    }

    case "bhagwat":
      await runJob(ctx, feature, "bhagwat", { url: text });
      break;

    case "thumbnail":
      await runJob(ctx, feature, "thumbnail", { url: text });
      break;

    case "agent": {
      const isUrl = text.startsWith("http");
      const spaceIdx = text.indexOf(" ");
      const payload: Record<string, unknown> = isUrl
        ? { url: spaceIdx !== -1 ? text.slice(0, spaceIdx) : text }
        : { message: text };
      if (isUrl && spaceIdx !== -1) payload["instructions"] = text.slice(spaceIdx + 1);
      await runJob(ctx, feature, "agent", payload);
      break;
    }

    case "uploads":
      await runJob(ctx, feature, "uploads", { url: text });
      break;
  }
});

bot.catch((err) => {
  logger.error({ err }, "Telegraf error");
});
