import type { Telegram } from "telegraf";
import { formatResult, esc, type Feature } from "./format.js";
import type { JobEnvelope } from "./vms.js";
import { MAIN_MENU, retryKb } from "./keyboards.js";

/**
 * Resolves the authenticated VMS redirector URL to its public S3 presigned destination.
 * Safe fallback: returns the original URL on network errors or auth failures.
 */
async function resolveMediaUrl(url: string): Promise<string> {
  const apiKey = process.env["VMS_API_KEY"];
  if (!apiKey) return url;

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      redirect: "manual",
    });

    if (res.status === 302 || res.status === 301 || res.status === 307 || res.status === 308) {
      const location = res.headers.get("location");
      if (location) return location;
    }
  } catch (err) {
    console.error("[deliver] Failed to resolve media redirect:", err);
  }
  return url;
}

/**
 * Deliver a finished VMS job to a Telegram chat. Host-agnostic: works from
 * Lambda B (webhook) and from the local runner (after polling).
 *
 * Behaviour, by branch:
 *  - Failure → red error message + retryKb(feature) for one-tap retry.
 *  - Subtitles (document) → sendDocument with MAIN_MENU.
 *  - Cut / Download (media URL) → try sendVideo/sendAudio so it plays inline;
 *    if Telegram can't fetch the URL (size, codec, etc.), fall back to the
 *    plain link message.
 *  - Text result (clips, timestamps, transcript, errors) → sendMessage(s).
 */
export async function deliverResult(
  telegram: Telegram,
  chatId: number,
  feature: Feature,
  job: JobEnvelope,
  opts: { statusMessageId?: number; username?: string; payload?: Record<string, unknown> } = {},
): Promise<void> {
  // Remove the "working…" placeholder if we have one.
  if (opts.statusMessageId !== undefined) {
    try {
      await telegram.deleteMessage(chatId, opts.statusMessageId);
    } catch {
      /* already gone */
    }
  }

  // Resolve VMS redirector URL to a direct public S3 presigned URL
  const originalUrl = (job.result?.["url"] ??
    job.result?.["downloadUrl"] ??
    job.result?.["fileUrl"]) as string | undefined;

  if (originalUrl) {
    const publicUrl = await resolveMediaUrl(originalUrl);
    if (job.result) {
      if (job.result["url"]) job.result["url"] = publicUrl;
      if (job.result["downloadUrl"]) job.result["downloadUrl"] = publicUrl;
      if (job.result["fileUrl"]) job.result["fileUrl"] = publicUrl;
    }
  }

  const formatted = formatResult(job, feature);
  const trailingKb = formatted.failed ? retryKb(feature) : {};

  // Attach context string to the very first message caption/text if available
  if (opts.username && formatted.messages.length > 0) {
    let contextStr = `\n\n👤 Requested by: @${opts.username}`;
    if (opts.payload) {
      const url = opts.payload["url"] as string | undefined;
      const start = opts.payload["startTime"] as number | undefined;
      const end = opts.payload["endTime"] as number | undefined;
      if (url) {
        // Escape: the stored URL is the raw user text, so an unescaped `<`/`&`
        // would break HTML parse_mode and fail the whole sendMessage.
        contextStr += `\n🔗 Link: <code>${esc(url)}</code>`;
      }
      if (start !== undefined && end !== undefined) {
        // Quick local format for time
        const fmt = (s: number) => {
          const m = Math.floor(s / 60);
          const sc = s % 60;
          return m > 0 ? `${m}:${String(sc).padStart(2, "0")}` : `${sc}s`;
        };
        contextStr += `\n⏱ Time: ${fmt(start)} - ${fmt(end)}`;
      }
    }
    // Append to the first message
    formatted.messages[0] += contextStr;
  }

  // ── Documents (subtitles .srt / transcript .txt) ──
  if (formatted.document) {
    await telegram.sendDocument(
      chatId,
      {
        source: Buffer.from(formatted.document.content, "utf-8"),
        filename: formatted.document.filename,
      },
      {
        caption: (formatted.document.caption || "") + (opts.username && formatted.messages.length === 0 ? `\n\n👤 Requested by: @${opts.username}` : ""),
        parse_mode: "HTML",
        ...trailingKb,
      },
    );
    return;
  }

  // ── Inline media (cut / download) ──
  if (formatted.media && formatted.messages[0]) {
    const caption = formatted.messages[0];
    try {
      if (formatted.media.kind === "video") {
        await telegram.sendVideo(chatId, formatted.media.url, {
          caption,
          parse_mode: "HTML",
          ...trailingKb,
        });
      } else {
        await telegram.sendAudio(chatId, formatted.media.url, {
          caption,
          parse_mode: "HTML",
          ...trailingKb,
        });
      }
      return;
    } catch {
      /* fall through to plain link delivery */
    }
  }

  // ── Plain text messages (one or many chunks) ──
  for (let i = 0; i < formatted.messages.length; i++) {
    const isLast = i === formatted.messages.length - 1;
    await telegram.sendMessage(chatId, formatted.messages[i]!, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(isLast ? trailingKb : {}),
    });
  }
}
