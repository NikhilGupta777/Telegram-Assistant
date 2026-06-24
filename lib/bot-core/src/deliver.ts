import type { Telegram } from "telegraf";
import { formatResult, type Feature } from "./format.js";
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
  opts: { statusMessageId?: number } = {},
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
  const trailingKb = formatted.failed ? retryKb(feature) : MAIN_MENU;

  // ── Documents (subtitles .srt / transcript .txt) ──
  if (formatted.document) {
    await telegram.sendDocument(
      chatId,
      {
        source: Buffer.from(formatted.document.content, "utf-8"),
        filename: formatted.document.filename,
      },
      {
        caption: formatted.document.caption,
        parse_mode: "HTML",
        ...trailingKb,
      },
    );
    return;
  }

  // ── Inline media (cut / download) ──
  // Telegram will fetch the URL itself and re-host the file so users can
  // tap-to-play. If it fails (URL not fetchable, file too large for Telegram
  // to ingest, codec mismatch, etc.), we silently fall through to the
  // text-link message below so the user always gets something usable.
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
