import { Telegraf, Markup } from "telegraf";
import { logger } from "./lib/logger.js";
import { startJob, waitForJob } from "./lib/vms.js";
import type { JobEnvelope } from "./lib/vms.js";
import type { Message } from "telegraf/types";

const token = process.env["TELEGRAM_BOT_TOKEN"];
if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");

export const bot = new Telegraf(token);

// ─── Types ────────────────────────────────────────────────────────────────────

type ActiveFeature = "clips" | "cut" | "subtitles" | "timestamps" | "download";

type Step =
  | "clips_url"
  | "cut_url"
  | "cut_start"
  | "cut_end"
  | "subtitles_url"
  | "timestamps_url"
  | "download_url"
  | "download_type";

interface SessionState {
  feature?: ActiveFeature;
  step?: Step;
  data?: Record<string, unknown>;
  expiresAt?: number;
}

// ─── Session Store ────────────────────────────────────────────────────────────

const sessions = new Map<number, SessionState>();
const SESSION_TTL = 30 * 60 * 1000;

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

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (s.expiresAt && now > s.expiresAt) sessions.delete(id);
  }
}, 15 * 60 * 1000);

// ─── Utilities ────────────────────────────────────────────────────────────────

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

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
    const u = new URL(text.trim());
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

function retryKb(feat: ActiveFeature) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔄 Try Again", `feat:${feat}`)],
    [Markup.button.callback("🏠 Main Menu", "menu")],
  ]);
}

// ─── Welcome ──────────────────────────────────────────────────────────────────

const WELCOME = `🙏 <b>Narayan Bhakt Editor</b>

Your AI-powered video studio. Choose a feature:

✅ <b>Available now:</b>
🎬 <b>Best Clips</b> — Find viral moments automatically
✂️ <b>Clip Cut</b> — Cut any section of a video
📝 <b>Subtitles</b> — Generate subtitles &amp; transcript
⏱ <b>Timestamps</b> — Auto-generate YouTube chapters
⬇️ <b>Download</b> — Download YouTube videos

🔒 <b>Coming soon:</b>
📖 Bhagwat AI Editor  •  🖼 Thumbnail Studio
🤖 AI Copilot  •  ☁️ Uploads &amp; Sharing`;

// ─── Result Formatter ─────────────────────────────────────────────────────────

function formatResult(
  job: JobEnvelope,
  feature: ActiveFeature,
): { text: string; imageUrl?: string; srtContent?: string } {
  if (job.failed || job.status === "error" || job.status === "cancelled") {
    const msg = job.message ?? "Something went wrong. Please try again.";
    return {
      text: `❌ <b>Job failed</b>\n\n${esc(msg)}\n\n<i>Please try again with a different URL.</i>`,
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
            (desc ? `   <i>${esc(desc.slice(0, 120))}</i>` : "")
          ).trimEnd();
        });
        return {
          text:
            `🎬 <b>Best Clips Found!</b> (${clips.length} clips)\n\n` +
            lines.join("\n\n") +
            `\n\n<i>Tip: Use ✂️ Clip Cut to download any clip</i>`,
        };
      }
      return {
        text: `🎬 <b>Done!</b>\n\n<pre>${esc(JSON.stringify(result, null, 2).slice(0, 2000))}</pre>`,
      };
    }

    case "cut": {
      const url = (result["url"] ??
        result["downloadUrl"] ??
        result["fileUrl"]) as string | undefined;
      if (url)
        return {
          text: `✂️ <b>Your clip is ready!</b>\n\n<a href="${esc(url)}">⬇️ Download Clip</a>`,
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
          text: `⬇️ <b>Download ready!</b>\n\n<a href="${esc(url)}">⬇️ Click to download</a>`,
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
          text: `📝 <b>Subtitles generated!</b>\n\nYour <code>.srt</code> subtitle file is attached below.`,
          srtContent: content,
        };
      }
      if (text) {
        const preview = text.slice(0, 2000);
        return {
          text:
            `📝 <b>Transcript ready!</b>\n\n${esc(preview)}` +
            (text.length > 2000 ? "\n\n<i>…truncated</i>" : ""),
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
        return {
          text:
            `⏱ <b>AI Timestamps</b> (${ts.length} chapters)\n\n` +
            lines.join("\n").slice(0, 3500) +
            `\n\n<i>📋 Copy &amp; paste into your YouTube description</i>`,
        };
      }
      return {
        text: `⏱ <b>Done!</b>\n\n<pre>${esc(JSON.stringify(result, null, 2).slice(0, 1500))}</pre>`,
      };
    }
  }
}

// ─── Job Runner ───────────────────────────────────────────────────────────────

type BotCtx = Parameters<Parameters<typeof bot.on>[1]>[0];

const PROGRESS_MSGS = [
  "Analysing video…",
  "AI is working its magic…",
  "Processing…",
  "Almost done…",
  "Finalising results…",
];

async function runJob(
  ctx: BotCtx,
  feature: ActiveFeature,
  endpoint: string,
  payload: Record<string, unknown>,
) {
  let statusMsg: Message.TextMessage | undefined;

  try {
    const job = await startJob(endpoint, payload);

    statusMsg = await ctx.reply(`⏳ <b>Working on it…</b>\n\n🔄 Starting up…`, {
      parse_mode: "HTML",
    });

    let tick = 0;
    const done = await waitForJob(job.jobId, async (current) => {
      const pct = current.progress != null ? ` ${current.progress}%` : "";
      const msg = PROGRESS_MSGS[tick % PROGRESS_MSGS.length]!;
      tick++;
      try {
        await ctx.telegram.editMessageText(
          ctx.chat!.id,
          statusMsg!.message_id,
          undefined,
          `⏳ <b>Working on it…</b>\n\n🔄 ${msg}${pct}`,
          { parse_mode: "HTML" },
        );
      } catch { /* ignore */ }
    });

    try {
      await ctx.telegram.deleteMessage(ctx.chat!.id, statusMsg.message_id);
    } catch { /* ok */ }

    const { text, imageUrl, srtContent } = formatResult(done, feature);

    if (srtContent) {
      await ctx.replyWithDocument(
        { source: Buffer.from(srtContent, "utf-8"), filename: "subtitles.srt" },
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
      } catch { /* ok */ }
    }

    let userMsg = raw;
    try {
      const jsonStart = raw.indexOf("{");
      if (jsonStart !== -1) {
        const parsed = JSON.parse(raw.slice(jsonStart)) as {
          error?: { message?: string };
          message?: string;
        };
        userMsg = parsed?.error?.message ?? parsed?.message ?? raw;
      }
    } catch { /* use raw */ }

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
      `1️⃣ Tap a feature button\n` +
      `2️⃣ Follow the prompts step by step\n` +
      `3️⃣ Paste your YouTube link when asked\n` +
      `4️⃣ Wait for your result (30s – 3 min)\n\n` +
      `<b>Commands:</b>\n` +
      `/start — 🏠 Main menu\n` +
      `/cancel — ❌ Cancel current action\n` +
      `/help — ❓ This message\n\n` +
      `<b>Clip Cut time formats:</b>\n` +
      `• Seconds: <code>90</code>\n` +
      `• MM:SS: <code>1:30</code>\n` +
      `• HH:MM:SS: <code>0:01:30</code>`,
    { parse_mode: "HTML", ...MAIN_MENU },
  );
});

bot.command("cancel", async (ctx) => {
  clearSession(ctx.from.id);
  await ctx.reply("✅ Cancelled.", MAIN_MENU);
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
  await ctx.reply("✅ Cancelled.", MAIN_MENU);
});

// Coming soon handler
bot.action("soon", async (ctx) => {
  await ctx.answerCbQuery(
    "🔒 Coming soon! Stay tuned.",
    { show_alert: true },
  );
});

// ── Best Clips ────────────────────────────────────────────────────────────────
bot.action("feat:clips", async (ctx) => {
  await ctx.answerCbQuery();
  setSession(ctx.from.id, { feature: "clips", step: "clips_url", data: {} });
  await ctx.reply(
    `🎬 <b>Best Clips</b>\n\nStep 1 of 1 — Send your YouTube link:\n\n<code>https://youtu.be/abc123</code>`,
    { parse_mode: "HTML", ...CANCEL_KB },
  );
});

// ── Clip Cut ──────────────────────────────────────────────────────────────────
bot.action("feat:cut", async (ctx) => {
  await ctx.answerCbQuery();
  setSession(ctx.from.id, { feature: "cut", step: "cut_url", data: {} });
  await ctx.reply(
    `✂️ <b>Clip Cut</b>\n\n<b>Step 1 of 3</b> — Send your YouTube link:\n\n<code>https://youtu.be/abc123</code>`,
    { parse_mode: "HTML", ...CANCEL_KB },
  );
});

// ── Subtitles ─────────────────────────────────────────────────────────────────
bot.action("feat:subtitles", async (ctx) => {
  await ctx.answerCbQuery();
  setSession(ctx.from.id, {
    feature: "subtitles",
    step: "subtitles_url",
    data: {},
  });
  await ctx.reply(
    `📝 <b>Subtitles</b>\n\nStep 1 of 1 — Send your YouTube link:\n\n<code>https://youtu.be/abc123</code>\n\n<i>Subtitles will be sent as a .srt file</i>`,
    { parse_mode: "HTML", ...CANCEL_KB },
  );
});

// ── Timestamps ────────────────────────────────────────────────────────────────
bot.action("feat:timestamps", async (ctx) => {
  await ctx.answerCbQuery();
  setSession(ctx.from.id, {
    feature: "timestamps",
    step: "timestamps_url",
    data: {},
  });
  await ctx.reply(
    `⏱ <b>AI Timestamps</b>\n\nStep 1 of 1 — Send your YouTube link:\n\n<code>https://youtu.be/abc123</code>\n\n<i>Optionally add instructions after the link:\n<code>https://youtu.be/abc123  Make 10 detailed chapters</code></i>`,
    { parse_mode: "HTML", ...CANCEL_KB },
  );
});

// ── Download ──────────────────────────────────────────────────────────────────
bot.action("feat:download", async (ctx) => {
  await ctx.answerCbQuery();
  setSession(ctx.from.id, {
    feature: "download",
    step: "download_url",
    data: {},
  });
  await ctx.reply(
    `⬇️ <b>Download</b>\n\nStep 1 of 2 — Send your YouTube link:\n\n<code>https://youtu.be/abc123</code>`,
    { parse_mode: "HTML", ...CANCEL_KB },
  );
});

// ── Download type buttons ─────────────────────────────────────────────────────
bot.action("dl:video", async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.from.id);
  const url = session.data?.["url"] as string | undefined;
  if (!url) {
    await ctx.reply("⚠️ Session expired. Please start again:", MAIN_MENU);
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
    await ctx.reply("⚠️ Session expired. Please start again:", MAIN_MENU);
    return;
  }
  clearSession(ctx.from.id);
  await ctx.reply("✅ Extracting audio…");
  await runJob(ctx, "download", "download", { url, audioOnly: true });
});

// ─── Text Handler ─────────────────────────────────────────────────────────────

bot.on("text", async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text.trim();

  if (text.startsWith("/")) return;

  const session = getSession(userId);

  if (!session.step) {
    await ctx.reply("👇 Choose a feature to get started:", MAIN_MENU);
    return;
  }

  // ── Clip Cut: 3-step form ──────────────────────────────────────────────────

  if (session.step === "cut_url") {
    if (!isValidUrl(text)) {
      await ctx.reply(
        `❌ That doesn't look like a valid link.\n\nPlease send a YouTube URL:\n<code>https://youtu.be/abc123</code>`,
        { parse_mode: "HTML", ...CANCEL_KB },
      );
      return;
    }
    setSession(userId, { step: "cut_start", data: { url: text } });
    await ctx.reply(
      `✂️ <b>Clip Cut</b>\n\n<b>Step 2 of 3</b> — Send the <b>start time</b> of your clip:\n\n` +
        `Examples: <code>1:23</code>  or  <code>83</code>  or  <code>0:01:23</code>`,
      { parse_mode: "HTML", ...CANCEL_KB },
    );
    return;
  }

  if (session.step === "cut_start") {
    const start = parseSeconds(text);
    if (start === null) {
      await ctx.reply(
        `❌ <b>Invalid time</b>\n\nAccepted formats:\n• MM:SS → <code>1:23</code>\n• Seconds → <code>83</code>\n• HH:MM:SS → <code>0:01:23</code>`,
        { parse_mode: "HTML", ...CANCEL_KB },
      );
      return;
    }
    setSession(userId, {
      step: "cut_end",
      data: { ...session.data, startTime: start },
    });
    await ctx.reply(
      `✂️ <b>Clip Cut</b>\n\n<b>Step 3 of 3</b> — Send the <b>end time</b> of your clip:\n\n` +
        `Start: <code>${fmtTime(start)}</code>\n` +
        `Examples: <code>2:45</code>  or  <code>165</code>  or  <code>0:02:45</code>`,
      { parse_mode: "HTML", ...CANCEL_KB },
    );
    return;
  }

  if (session.step === "cut_end") {
    const end = parseSeconds(text);
    const start = session.data?.["startTime"] as number;
    const url = session.data?.["url"] as string;

    if (end === null) {
      await ctx.reply(
        `❌ <b>Invalid time</b>\n\nAccepted formats:\n• MM:SS → <code>2:45</code>\n• Seconds → <code>165</code>\n• HH:MM:SS → <code>0:02:45</code>`,
        { parse_mode: "HTML", ...CANCEL_KB },
      );
      return;
    }
    if (end <= start) {
      await ctx.reply(
        `❌ End time must be <b>after</b> start time.\n\nStart: <code>${fmtTime(start)}</code>\nYour end: <code>${fmtTime(end)}</code>\n\nSend a later end time:`,
        { parse_mode: "HTML", ...CANCEL_KB },
      );
      return;
    }

    clearSession(userId);
    await ctx.reply(
      `✅ <b>Cutting clip</b>\n\nFrom <code>${fmtTime(start)}</code> to <code>${fmtTime(end)}</code> (${fmtTime(end - start)} long)`,
      { parse_mode: "HTML" },
    );
    await runJob(ctx, "cut", "clip-cut", {
      url,
      startTime: start,
      endTime: end,
    });
    return;
  }

  // ── Download: ask type via buttons after URL ───────────────────────────────

  if (session.step === "download_url") {
    if (!isValidUrl(text)) {
      await ctx.reply(
        `❌ Please send a valid YouTube URL:\n<code>https://youtu.be/abc123</code>`,
        { parse_mode: "HTML", ...CANCEL_KB },
      );
      return;
    }
    setSession(userId, { step: "download_type", data: { url: text } });
    await ctx.reply(
      `⬇️ <b>Step 2 of 2</b> — What do you want to download?`,
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
    return;
  }

  if (session.step === "download_type") {
    await ctx.reply(
      `👆 Please tap <b>Video</b> or <b>Audio</b> on the message above.`,
      { parse_mode: "HTML" },
    );
    return;
  }

  // ── Single-step features ───────────────────────────────────────────────────

  if (session.step === "clips_url") {
    if (!isValidUrl(text.split(/\s+/)[0]!)) {
      await ctx.reply(
        `❌ Please send a valid YouTube URL:\n<code>https://youtu.be/abc123</code>`,
        { parse_mode: "HTML", ...CANCEL_KB },
      );
      return;
    }
    const parts = text.split(/\s+/);
    const url = parts[0]!;
    const durStr = parts[1];
    const durations = durStr
      ? durStr.split(",").map(Number).filter((n) => !isNaN(n) && n > 0)
      : [30, 60];
    clearSession(userId);
    await ctx.reply("🎬 Analysing video to find the best clips…");
    await runJob(ctx, "clips", "clips", { url, durations, auto: true });
    return;
  }

  if (session.step === "subtitles_url") {
    const url = text.split(/\s+/)[0]!;
    if (!isValidUrl(url)) {
      await ctx.reply(
        `❌ Please send a valid YouTube URL:\n<code>https://youtu.be/abc123</code>`,
        { parse_mode: "HTML", ...CANCEL_KB },
      );
      return;
    }
    clearSession(userId);
    await ctx.reply("📝 Generating subtitles…");
    await runJob(ctx, "subtitles", "subtitles", { url, language: "auto" });
    return;
  }

  if (session.step === "timestamps_url") {
    const spaceIdx = text.indexOf(" ");
    const url = spaceIdx !== -1 ? text.slice(0, spaceIdx) : text;
    if (!isValidUrl(url)) {
      await ctx.reply(
        `❌ Please send a valid YouTube URL:\n<code>https://youtu.be/abc123</code>`,
        { parse_mode: "HTML", ...CANCEL_KB },
      );
      return;
    }
    const instructions =
      spaceIdx !== -1 ? text.slice(spaceIdx + 1).trim() : undefined;
    clearSession(userId);
    await ctx.reply("⏱ Generating chapter timestamps…");
    await runJob(ctx, "timestamps", "timestamps", {
      url,
      ...(instructions ? { instructions } : {}),
    });
    return;
  }

  // Fallback
  await ctx.reply("👇 Choose a feature to get started:", MAIN_MENU);
});

bot.catch((err) => {
  logger.error({ err }, "Telegraf error");
});
