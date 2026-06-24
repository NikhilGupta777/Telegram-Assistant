import type { JobEnvelope } from "./vms.js";
import { isSucceeded } from "./vms.js";

export type Feature =
  | "clips"
  | "cut"
  | "subtitles"
  | "timestamps"
  | "download";

/** Telegram hard limit for a text message body. */
export const TG_MAX = 4096;
/** Leave headroom for closing tags / footers we append. */
const TG_SAFE = 3900;

// ─── Escaping & parsing ──────────────────────────────────────────────────────

/**
 * Escape text for Telegram HTML parse_mode.
 * Note: `"` must be escaped too — otherwise a URL containing a quote breaks
 * out of an <a href="..."> attribute.
 */
export function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function parseSeconds(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  const parts = trimmed.split(":");
  if (parts.length === 1) {
    const n = Number(parts[0]);
    return !Number.isFinite(n) || n < 0 ? null : n;
  }
  if (parts.length === 2) {
    const m = Number(parts[0]);
    const s = Number(parts[1]);
    if (!Number.isFinite(m) || !Number.isFinite(s) || m < 0 || s < 0 || s >= 60)
      return null;
    return m * 60 + s;
  }
  if (parts.length === 3) {
    const h = Number(parts[0]);
    const m = Number(parts[1]);
    const s = Number(parts[2]);
    if (
      !Number.isFinite(h) ||
      !Number.isFinite(m) ||
      !Number.isFinite(s) ||
      h < 0 ||
      m < 0 ||
      s < 0 ||
      m >= 60 ||
      s >= 60
    )
      return null;
    return h * 3600 + m * 60 + s;
  }
  return null;
}

export function fmtTime(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds >= 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Accepts any http/https URL — used for generic validation. */
export function isValidUrl(text: string): boolean {
  try {
    const u = new URL(text.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Accepts only YouTube URLs (youtube.com, youtu.be, m.youtube.com).
 * Used by the flow to catch non-YouTube links before wasting an API call.
 */
export function isYouTubeUrl(text: string): boolean {
  try {
    const u = new URL(text.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const host = u.hostname.replace(/^(www\.|m\.)/, "");
    return host === "youtube.com" || host === "youtu.be";
  } catch {
    return false;
  }
}

/** Split a long HTML message into Telegram-sized chunks on line boundaries. */
export function chunkMessage(text: string, max = TG_SAFE): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    // A single overlong line: hard-split it.
    if (line.length > max) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      for (let i = 0; i < line.length; i += max) {
        chunks.push(line.slice(i, i + max));
      }
      continue;
    }
    if (current.length + line.length + 1 > max) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// ─── Result formatting ───────────────────────────────────────────────────────

export interface FormattedResult {
  /** Primary message text(s). More than one if it exceeded TG_MAX. */
  messages: string[];
  /** If present, send as a document instead of/in addition to text. */
  document?: { content: string; filename: string; caption: string };
}

function pickUrl(result: Record<string, unknown>): string | undefined {
  return (result["url"] ??
    result["downloadUrl"] ??
    result["fileUrl"]) as string | undefined;
}

export function formatResult(
  job: JobEnvelope,
  feature: Feature,
): FormattedResult {
  if (!isSucceeded(job)) {
    const msg = job.message ?? "Something went wrong. Please try again.";
    return {
      messages: [
        `❌ <b>Job failed</b>\n\n${esc(msg)}\n\n<i>Please try again with a different URL.</i>`,
      ],
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
        const header = `🎬 <b>Best Clips Found!</b> (${clips.length} clips)\n\n`;
        const footer = `\n\n<i>Tip: Use ✂️ Clip Cut to download any clip</i>`;
        return {
          messages: chunkMessage(header + lines.join("\n\n") + footer),
        };
      }
      return rawFallback("🎬", result);
    }

    case "cut": {
      const url = pickUrl(result);
      if (url) {
        return {
          messages: [
            `✂️ <b>Your clip is ready!</b>\n\n<a href="${esc(url)}">⬇️ Download Clip</a>`,
          ],
        };
      }
      return rawFallback("✂️", result);
    }

    case "download": {
      const url = pickUrl(result);
      if (url) {
        return {
          messages: [
            `⬇️ <b>Download ready!</b>\n\n<a href="${esc(url)}">⬇️ Click to download</a>`,
          ],
        };
      }
      return rawFallback("⬇️", result);
    }

    case "subtitles": {
      const srt = result["srt"] as string | undefined;
      const vtt = result["vtt"] as string | undefined;
      const transcript = (result["text"] ?? result["transcript"]) as
        | string
        | undefined;
      const content = srt ?? vtt;
      if (content) {
        return {
          messages: [],
          document: {
            content,
            filename: srt ? "subtitles.srt" : "subtitles.vtt",
            caption: `📝 <b>Subtitles generated!</b>\n\nYour subtitle file is attached.`,
          },
        };
      }
      if (transcript) {
        // Attach long transcripts as a file rather than truncating.
        if (transcript.length > TG_SAFE) {
          return {
            messages: [],
            document: {
              content: transcript,
              filename: "transcript.txt",
              caption: `📝 <b>Transcript ready!</b>\n\nFull transcript attached.`,
            },
          };
        }
        return {
          messages: [`📝 <b>Transcript ready!</b>\n\n${esc(transcript)}`],
        };
      }
      return rawFallback("📝", result);
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
        const header = `⏱ <b>AI Timestamps</b> (${ts.length} chapters)\n\n`;
        const footer = `\n\n<i>📋 Copy &amp; paste into your YouTube description</i>`;
        return {
          messages: chunkMessage(header + lines.join("\n") + footer),
        };
      }
      return rawFallback("⏱", result);
    }
  }
}

function rawFallback(
  emoji: string,
  result: Record<string, unknown>,
): FormattedResult {
  const json = JSON.stringify(result, null, 2);
  return {
    messages: [
      `${emoji} <b>Done!</b> Got a result, but couldn't format it nicely.\n\n<pre>${esc(json.slice(0, 1500))}</pre>`,
    ],
  };
}

// ─── VMS error-code → friendly message ──────────────────────────────────────

export function friendlyError(code: string | undefined, fallback: string): string {
  switch (code) {
    case "RATE_LIMIT_EXCEEDED":
      return "⏳ You're going a bit fast — please wait a moment and try again.";
    case "MONTHLY_QUOTA_EXCEEDED":
      return "📵 Monthly quota reached. Please try again next month.";
    case "INVALID_REQUEST":
    case "UPSTREAM_VALIDATION":
      return "⚠️ That input wasn't accepted. Check the link and try again.";
    case "JOB_NOT_FOUND":
      return "🔍 That job could not be found.";
    case "INVALID_API_KEY":
    case "FORBIDDEN_SCOPE":
      return "🔒 The bot's API access is misconfigured. Please contact the admin.";
    case "UPSTREAM_ERROR":
    case "INTERNAL_ERROR":
      return "🛠 The video service had a hiccup. Please try again shortly.";
    default:
      return fallback;
  }
}
