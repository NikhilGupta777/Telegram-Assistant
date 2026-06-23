import { Telegraf, Markup } from "telegraf";
import { logger } from "./lib/logger.js";
import { startJob, waitForJob } from "./lib/vms.js";
import type { JobEnvelope } from "./lib/vms.js";
import type { Message } from "telegraf/types";

const token = process.env["TELEGRAM_BOT_TOKEN"];
if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");

export const bot = new Telegraf(token);

// ─── Types ────────────────────────────────────────────────────────────────────

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
  step?: "awaiting_input" | "awaiting_dl_type";
  data?: Record<string, unknown>;
  expiresAt?: number;
}

// ─── Session Store ────────────────────────────────────────────────────────────

const sessions = new Map<number, SessionState>();
const SESSION_TTL = 30 * 60 * 1000; // 30 minutes

function getSession(userId: number): SessionState {
  const s = sessions.get(userId);
  if (!s || (s.expiresAt && Date.now() > s.expiresAt)) {
    const fresh: SessionState = { expiresAt: Date.now() + SESSION_TTL };
    sessions.set(userId, fresh);
    return fresh;
  }
  return s;
}

function setSession(userId: number, patch: Partial<SessionState>) {
  const s = getSession(userId);
  Object.assign(s, patch, { expiresAt: Date.now() + SESSION_TTL });
}

function clearSession(userId: number) {
  sessions.set(userId, { expiresAt: Date.now() + SESSION_TTL });
}

// Cleanup expired sessions every 15 minutes
setInterval(
  () => {
    const now = Date.now();
    for (const [id, s] of sessions) {
      if (s.expiresAt && now > s.expiresAt) sessions.delete(id);
    }
  },
  15 * 60 * 1000,
);

// ─── Utilities ────────────────────────────────────────────────────────────────

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Accepts: 90  |  1:30  |  0:01:30  → returns seconds, or null if invalid */
function parseSeconds(input: string): number | null {
  const parts = input.trim().split(":");
  if (parts.length === 1) {
    const n = Number(parts[0]);
    return isNaN(n) || n < 0 ? null : n;
  }
  if (parts.length === 2) {
    const m = Number(parts[0]);
    const s = Number(parts[1]);
    if (isNaN(m) || isNaN(s) || s >= 60) return null;
    return m * 60 + s;
  }
  if (parts.length === 3) {
    const h = Number(parts[0]);
    const m = Number(parts[1]);
    const s = Number(parts[2]);
    if (isNaN(h) || isNaN(m) || isNaN(s) || m >= 60 || s >= 60) return null;
    return h * 3600 + m * 60 + s;
  }
  return null;
}

function fmtTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function isValidUrl(text: string): boolean {
  try {
    const u = new URL(text);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// ─── Keyboards ───────────────────────────────────────────────────────────────

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
]);

function retryKb(feat: Feature) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔄 Try Again", `feat:${feat}`)],
    [Markup.button.callback("🏠 Main Menu", "menu")],
  ]);
}

// ─── Static Text ──────────────────────────────────────────────────────────────

const WELCOME = `🙏 <b>Narayan Bhakt Editor</b>

Your AI-powered video studio is ready!

<b>What I can do:</b>
🎬 <b>Best Clips</b> — Find viral moments automatically
✂️ <b>Clip Cut</b> — Cut any section of a video
📝 <b>Subtitles</b> — Generate subtitles or transcript
⏱ <b>Timestamps</b> — Auto-generate chapter timestamps
⬇️ <b>Download</b> — Download YouTube videos
📖 <b>Bhagwat AI</b> — AI-powered video editor
🖼 <b>Thumbnail</b> — Generate AI thumbnails
🤖 <b>AI Copilot</b> — Your video production assistant
☁️ <b>Uploads</b> — Upload &amp; share videos

<b>👇 Choose a feature to get started:</b>`;

const FEATURE_PROMPTS: Record<Feature, string> = {
  clips: `🎬 <b>Best Clips Finder</b>

Send a YouTube URL and I'll find the best viral moments automatically.

<b>Just send the link:</b>
<code>https://youtu.be/abc123</code>

Or with custom lengths (seconds):
<code>https://youtu.be/abc123 30,60,90</code>`,

  cut: `✂️ <b>Clip Cut</b>

Send the URL followed by start and end times.

<b>Format:</b>
<code>URL  start  end</code>

<b>Time formats accepted:</b>
• Seconds → <code>90</code>
• MM:SS → <code>1:30</code>
• HH:MM:SS → <code>0:01:30</code>

<b>Example:</b>
<code>https://youtu.be/abc123  1:23  2:45</code>`,

  subtitles: `📝 <b>Subtitles / Transcript</b>

Paste a YouTube or video URL:
<code>https://youtu.be/abc123</code>

The subtitles will be sent as a downloadable .srt file.`,

  timestamps: `⏱ <b>AI Timestamps</b>

Paste a YouTube URL to generate chapter timestamps:
<code>https://youtu.be/abc123</code>

Or add custom instructions:
<code>https://youtu.be/abc123 Make 10 detailed chapters</code>`,

  download: `⬇️ <b>Download Video</b>

Paste a YouTube URL:
<code>https://youtu.be/abc123</code>`,

  bhagwat: `📖 <b>Bhagwat AI Editor</b>

Paste a video URL to process with Bhagwat AI:
<code>https://youtu.be/abc123</code>`,

  thumbnail: `🖼 <b>Thumbnail Studio</b>

Paste a YouTube URL to generate an AI thumbnail:
<code>https://youtu.be/abc123</code>`,

  agent: `🤖 <b>AI Studio Copilot</b>

Ask anything, or paste a URL with instructions:

<b>Examples:</b>
<code>How do I make better thumbnails?</code>
<code>https://youtu.be/abc123  Give me title ideas</code>`,

  uploads: `☁️ <b>Uploads &amp; Sharing</b>

Paste a public video or file URL to upload and get a share link:
<code>https://example.com/video.mp4</code>`,
};

// ─── Result Formatter ─────────────────────────────────────────────────────────

function formatResult(
  job: JobEnvelope,
  feature: Feature,
): { text: string; imageUrl?: string; srtContent?: string } {
  if (job.failed || job.status === "error" || job.status === "cancelled") {
    const msg = job.message ?? "Something went wrong. Please try again.";
    return {
      text: `❌ <b>Job failed</b>\n\n${esc(msg)}\n\n<i>Please try again with a different URL or contact support.</i>`,
    };
  }

  const result = job.result ?? {};

  switch (feature) {
    case "clips": {
      type Clip = {
        title?: string;
        start?: number;
        end?: number;
        startTime?: number;
        endTime?: number;
        reason?: string;
        description?: string;
      };
      const clips = (result["clips"] ??
        result["ideas"] ??
        result["data"]) as Clip[] | undefined;
      if (Array.isArray(clips) && clips.length > 0) {
        const lines = clips.map((c, i) => {
          const start = c.start ?? c.startTime ?? 0;
          const end = c.end ?? c.endTime ?? 0;
          const desc = c.reason ?? c.description ?? "";
          return (
            `${i + 1}. <b>${esc(c.title ?? `Clip ${i + 1}`)}</b>\n` +
            `   ⏱ <code>${fmtTime(start)}</code> → <code>${fmtTime(end)}</code>\n` +
            (desc ? `   ${esc(desc.slice(0, 120))}` : "")
          ).trimEnd();
        });
        return {
          text:
            `🎬 <b>Best Clips Found! (${clips.length})</b>\n\n` +
            lines.join("\n\n") +
            `\n\n<i>✂️ Use Clip Cut to download any of these clips</i>`,
        };
      }
      const raw = JSON.stringify(result, null, 2);
      return {
        text: `🎬 <b>Done!</b>\n\n<pre>${esc(raw.slice(0, 2000))}</pre>`,
      };
    }

    case "cut": {
      const url = (result["url"] ??
        result["downloadUrl"] ??
        result["fileUrl"]) as string | undefined;
      if (url)
        return {
          text: `✂️ <b>Clip is Ready!</b>\n\n<a href="${esc(url)}">⬇️ Download your clip</a>`,
        };
      return {
        text: `✂️ <b>Done!</b>\n\n<pre>${esc(JSON.stringify(result, null, 2).slice(0, 1500))}</pre>`,
      };
    }

    case "download": {
      const url = (result["url"] ??
        result["downloadUrl"] ??
        result["fileUrl"]) as string | undefined;
      if (url)
        return {
          text: `⬇️ <b>Download Ready!</b>\n\n<a href="${esc(url)}">⬇️ Click here to download</a>`,
        };
      return {
        text: `⬇️ <b>Done!</b>\n\n<pre>${esc(JSON.stringify(result, null, 2).slice(0, 1500))}</pre>`,
      };
    }

    case "subtitles": {
      const srt = result["srt"] as string | undefined;
      const vtt = result["vtt"] as string | undefined;
      const text = (result["text"] ?? result["transcript"]) as
        | string
        | undefined;
      const content = srt ?? vtt;
      if (content) {
        return {
          text: `📝 <b>Subtitles Generated!</b>\n\nYour .srt subtitle file is ready to download.`,
          srtContent: content,
        };
      }
      if (text) {
        const preview = text.slice(0, 2000);
        return {
          text:
            `📝 <b>Transcript Ready!</b>\n\n${esc(preview)}` +
            (text.length > 2000 ? "\n\n<i>…(truncated — full transcript above)</i>" : ""),
        };
      }
      return {
        text: `📝 <b>Done!</b>\n\n<pre>${esc(JSON.stringify(result, null, 2).slice(0, 1500))}</pre>`,
      };
    }

    case "timestamps": {
      type Chapter = { time?: number; label?: string; title?: string };
      const ts = (result["timestamps"] ?? result["chapters"]) as
        | Chapter[]
        | undefined;
      if (Array.isArray(ts) && ts.length > 0) {
        const lines = ts.map(
          (t) =>
            `<code>${fmtTime(t.time ?? 0)}</code> — ${esc(t.label ?? t.title ?? "Chapter")}`,
        );
        const joined = lines.join("\n");
        return {
          text:
            `⏱ <b>AI Timestamps (${ts.length} chapters)</b>\n\n` +
            joined.slice(0, 3500) +
            `\n\n<i>📋 Copy and paste into your YouTube description</i>`,
        };
      }
      return {
        text: `⏱ <b>Done!</b>\n\n<pre>${esc(JSON.stringify(result, null, 2).slice(0, 1500))}</pre>`,
      };
    }

    case "bhagwat": {
      const url = (result["url"] ??
        result["downloadUrl"] ??
        result["fileUrl"]) as string | undefined;
      const text = result["text"] as string | undefined;
      if (url)
        return {
          text: `📖 <b>Bhagwat AI Complete!</b>\n\n<a href="${esc(url)}">📥 Download Result</a>`,
        };
      if (text)
        return {
          text: `📖 <b>Bhagwat AI Result:</b>\n\n${esc(text.slice(0, 2500))}`,
        };
      return {
        text: `📖 <b>Done!</b>\n\n<pre>${esc(JSON.stringify(result, null, 2).slice(0, 1500))}</pre>`,
      };
    }

    case "thumbnail": {
      const url = (result["url"] ??
        result["imageUrl"] ??
        result["thumbnailUrl"]) as string | undefined;
      if (url) return { text: `🖼 <b>Thumbnail Ready!</b>`, imageUrl: url };
      return {
        text: `🖼 <b>Done!</b>\n\n<pre>${esc(JSON.stringify(result, null, 2).slice(0, 1500))}</pre>`,
      };
    }

    case "agent": {
      const reply = (result["reply"] ??
        result["response"] ??
        result["text"] ??
        result["message"]) as string | undefined;
      if (reply)
        return {
          text: `🤖 <b>AI Copilot:</b>\n\n${esc(reply.slice(0, 3000))}`,
        };
      return {
        text: `🤖 <b>Done!</b>\n\n<pre>${esc(JSON.stringify(result, null, 2).slice(0, 1500))}</pre>`,
      };
    }

    case "uploads": {
      const url = (result["url"] ??
        result["shareUrl"] ??
        result["publicUrl"]) as string | undefined;
      if (url)
        return {
          text: `☁️ <b>Uploaded &amp; Shared!</b>\n\n<a href="${esc(url)}">🔗 Copy Share Link</a>`,
        };
      return {
        text: `☁️ <b>Done!</b>\n\n<pre>${esc(JSON.stringify(result, null, 2).slice(0, 1500))}</pre>`,
      };
    }
  }
}

// ─── Job Runner ───────────────────────────────────────────────────────────────

type BotCtx = Parameters<Parameters<typeof bot.on>[1]>[0];

const PROGRESS_TEXTS = [
  "Analysing video…",
  "AI is working…",
  "Processing frames…",
  "Almost done…",
  "Finalising…",
];

async function runJob(
  ctx: BotCtx,
  feature: Feature,
  endpoint: string,
  payload: Record<string, unknown>,
) {
  let statusMsg: Message.TextMessage | undefined;

  try {
    const job = await startJob(endpoint, payload);

    statusMsg = await ctx.reply(
      `⏳ <b>Working on it…</b>\n\n🔄 Starting up…`,
      { parse_mode: "HTML" },
    );

    let tick = 0;
    const done = await waitForJob(
      job.jobId,
      async (current) => {
        const pct =
          current.progress != null ? ` (${current.progress}%)` : "";
        const progressText = PROGRESS_TEXTS[tick % PROGRESS_TEXTS.length]!;
        tick++;
        try {
          await ctx.telegram.editMessageText(
            ctx.chat!.id,
            statusMsg!.message_id,
            undefined,
            `⏳ <b>Working on it…</b>\n\n🔄 ${progressText}${pct}`,
            { parse_mode: "HTML" },
          );
        } catch {
          /* ignore edit failures — message may have been deleted */
        }
      },
    );

    // Remove progress message
    try {
      await ctx.telegram.deleteMessage(ctx.chat!.id, statusMsg.message_id);
    } catch {
      /* ok */
    }

    const { text, imageUrl, srtContent } = formatResult(done, feature);

    if (srtContent) {
      await ctx.replyWithDocument(
        {
          source: Buffer.from(srtContent, "utf-8"),
          filename: "subtitles.srt",
        },
        { caption: text, parse_mode: "HTML", ...MAIN_MENU },
      );
    } else if (imageUrl) {
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
    const raw = err instanceof Error ? err.message : String(err);

    if (statusMsg) {
      try {
        await ctx.telegram.deleteMessage(ctx.chat!.id, statusMsg.message_id);
      } catch {
        /* ok */
      }
    }

    // Try to extract a clean user-facing message from VMS error JSON
    let userMsg = raw;
    try {
      const jsonStart = raw.indexOf("{");
      if (jsonStart !== -1) {
        const parsed = JSON.parse(raw.slice(jsonStart)) as {
          error?: { message?: string };
          message?: string;
        };
        userMsg =
          parsed?.error?.message ?? parsed?.message ?? raw;
      }
    } catch {
      /* use raw */
    }

    await ctx.reply(
      `❌ <b>Something went wrong</b>\n\n${esc(userMsg.slice(0, 500))}`,
      { parse_mode: "HTML", ...retryKb(feature) },
    );
  }
}

// ─── Commands ─────────────────────────────────────────────────────────────────

bot.start(async (ctx) => {
  clearSession(ctx.from.id);
  await ctx.reply(WELCOME, { parse_mode: "HTML", ...MAIN_MENU });
});

bot.help(async (ctx) => {
  await ctx.reply(
    `🙏 <b>How to use Narayan Bhakt Editor</b>\n\n` +
      `1. Pick a feature from the menu below\n` +
      `2. Paste your YouTube URL when asked\n` +
      `3. Wait for results (usually 30s–3 min)\n\n` +
      `<b>Commands:</b>\n` +
      `/start — Back to main menu\n` +
      `/cancel — Cancel current action\n` +
      `/help — Show this message\n\n` +
      `<b>Tips:</b>\n` +
      `• For Clip Cut, use <code>1:30</code> or <code>90</code> for times\n` +
      `• Subtitles are sent as downloadable .srt files\n` +
      `• Best Clips finds viral moments automatically`,
    { parse_mode: "HTML", ...MAIN_MENU },
  );
});

bot.command("cancel", async (ctx) => {
  clearSession(ctx.from.id);
  await ctx.reply("✅ Cancelled. Choose a feature:", MAIN_MENU);
});

// ─── Actions ──────────────────────────────────────────────────────────────────

bot.action("menu", async (ctx) => {
  await ctx.answerCbQuery();
  clearSession(ctx.from.id);
  await ctx.reply(WELCOME, { parse_mode: "HTML", ...MAIN_MENU });
});

bot.action("cancel", async (ctx) => {
  await ctx.answerCbQuery("Cancelled ✅");
  clearSession(ctx.from.id);
  await ctx.reply("✅ Cancelled. Choose a feature:", MAIN_MENU);
});

// Download type picker
bot.action("dl:video", async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.from.id);
  const url = session.data?.["url"] as string | undefined;
  if (!url) {
    await ctx.reply(
      "⚠️ Session expired. Please start again:",
      MAIN_MENU,
    );
    return;
  }
  clearSession(ctx.from.id);
  await ctx.reply("✅ Downloading video…");
  await runJob(ctx, "download", "download", { url, audioOnly: false });
});

bot.action("dl:audio", async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.from.id);
  const url = session.data?.["url"] as string | undefined;
  if (!url) {
    await ctx.reply(
      "⚠️ Session expired. Please start again:",
      MAIN_MENU,
    );
    return;
  }
  clearSession(ctx.from.id);
  await ctx.reply("✅ Extracting audio…");
  await runJob(ctx, "download", "download", { url, audioOnly: true });
});

// Feature buttons
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
    setSession(ctx.from.id, {
      feature: feat,
      step: "awaiting_input",
      data: {},
    });
    await ctx.reply(FEATURE_PROMPTS[feat], {
      parse_mode: "HTML",
      ...CANCEL_KB,
    });
  });
}

// ─── Text Handler ─────────────────────────────────────────────────────────────

bot.on("text", async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text.trim();

  if (text.startsWith("/")) return;

  const session = getSession(userId);

  if (session.step !== "awaiting_input" && session.step !== "awaiting_dl_type") {
    await ctx.reply(
      "👇 Choose a feature to get started:",
      MAIN_MENU,
    );
    return;
  }

  // If waiting for download type picker but user typed text
  if (session.step === "awaiting_dl_type") {
    await ctx.reply(
      "👆 Please tap <b>Video</b> or <b>Audio</b> above.",
      { parse_mode: "HTML" },
    );
    return;
  }

  const feature = session.feature!;

  // ── URL-required features ──────────────────────────────────────────────────

  const needsUrl: Feature[] = [
    "clips", "cut", "subtitles", "timestamps",
    "download", "bhagwat", "thumbnail", "uploads",
  ];

  if (needsUrl.includes(feature)) {
    const firstToken = text.split(/\s+/)[0]!;
    if (!isValidUrl(firstToken)) {
      await ctx.reply(
        `❌ <b>Please paste a valid URL</b>\n\nMust start with <code>https://</code>\n\nExample: <code>https://youtu.be/abc123</code>`,
        { parse_mode: "HTML", ...CANCEL_KB },
      );
      return; // Keep session active so they can retry
    }
  }

  // ── Feature-specific logic ─────────────────────────────────────────────────

  switch (feature) {
    case "clips": {
      const parts = text.split(/\s+/);
      const url = parts[0]!;
      const durStr = parts[1];
      const durations = durStr
        ? durStr
            .split(",")
            .map(Number)
            .filter((n) => !isNaN(n) && n > 0)
        : [30, 60];
      clearSession(userId);
      await ctx.reply("🎬 Finding best clips…");
      await runJob(ctx, feature, "clips", { url, durations, auto: true });
      break;
    }

    case "cut": {
      const parts = text.split(/\s+/);
      if (parts.length < 3) {
        await ctx.reply(
          `❌ <b>Need 3 parts:</b> URL, start time, end time\n\nExample:\n<code>https://youtu.be/abc123  1:23  2:45</code>`,
          { parse_mode: "HTML", ...CANCEL_KB },
        );
        return; // Keep session
      }
      const start = parseSeconds(parts[1]!);
      const end = parseSeconds(parts[2]!);
      if (start === null || end === null) {
        await ctx.reply(
          `❌ <b>Invalid time format</b>\n\nAccepted formats:\n• Seconds: <code>90</code>\n• MM:SS: <code>1:30</code>\n• HH:MM:SS: <code>0:01:30</code>\n\nExample:\n<code>https://youtu.be/abc123  1:23  2:45</code>`,
          { parse_mode: "HTML", ...CANCEL_KB },
        );
        return; // Keep session
      }
      if (start >= end) {
        await ctx.reply(
          `❌ Start time must be <b>before</b> end time.\n\nYou entered: <code>${fmtTime(start)}</code> → <code>${fmtTime(end)}</code>`,
          { parse_mode: "HTML", ...CANCEL_KB },
        );
        return; // Keep session
      }
      clearSession(userId);
      await ctx.reply(`✂️ Cutting: <code>${fmtTime(start)}</code> → <code>${fmtTime(end)}</code>…`, { parse_mode: "HTML" });
      await runJob(ctx, feature, "clip-cut", {
        url: parts[0]!,
        startTime: start,
        endTime: end,
      });
      break;
    }

    case "subtitles": {
      const parts = text.split(/\s+/);
      const url = parts[0]!;
      const language = parts[1] ?? "auto";
      clearSession(userId);
      await ctx.reply("📝 Generating subtitles…");
      await runJob(ctx, feature, "subtitles", { url, language });
      break;
    }

    case "timestamps": {
      const spaceIdx = text.indexOf(" ");
      const url = spaceIdx !== -1 ? text.slice(0, spaceIdx) : text;
      const instructions = spaceIdx !== -1 ? text.slice(spaceIdx + 1) : undefined;
      clearSession(userId);
      await ctx.reply("⏱ Generating timestamps…");
      await runJob(ctx, feature, "timestamps", {
        url,
        ...(instructions ? { instructions } : {}),
      });
      break;
    }

    case "download": {
      const url = text.split(/\s+/)[0]!;
      setSession(userId, {
        feature: "download",
        step: "awaiting_dl_type",
        data: { url },
      });
      await ctx.reply(
        `⬇️ <b>What do you want to download?</b>\n\n<code>${esc(url)}</code>`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback("🎬 Full Video (MP4)", "dl:video"),
              Markup.button.callback("🎵 Audio Only (MP3)", "dl:audio"),
            ],
            [Markup.button.callback("❌ Cancel", "cancel")],
          ]),
        },
      );
      break;
    }

    case "bhagwat": {
      const url = text.split(/\s+/)[0]!;
      clearSession(userId);
      await ctx.reply("📖 Processing with Bhagwat AI…");
      await runJob(ctx, feature, "bhagwat", { url });
      break;
    }

    case "thumbnail": {
      const url = text.split(/\s+/)[0]!;
      clearSession(userId);
      await ctx.reply("🖼 Generating thumbnail…");
      await runJob(ctx, feature, "thumbnail", { url });
      break;
    }

    case "agent": {
      const isUrl = text.startsWith("http");
      const spaceIdx = text.indexOf(" ");
      const payload: Record<string, unknown> = isUrl
        ? { url: spaceIdx !== -1 ? text.slice(0, spaceIdx) : text }
        : { message: text };
      if (isUrl && spaceIdx !== -1) payload["instructions"] = text.slice(spaceIdx + 1);
      clearSession(userId);
      await ctx.reply("🤖 AI Copilot thinking…");
      await runJob(ctx, feature, "agent", payload);
      break;
    }

    case "uploads": {
      const url = text.split(/\s+/)[0]!;
      clearSession(userId);
      await ctx.reply("☁️ Uploading…");
      await runJob(ctx, feature, "uploads", { url });
      break;
    }
  }
});

bot.catch((err) => {
  logger.error({ err }, "Telegraf error");
});
