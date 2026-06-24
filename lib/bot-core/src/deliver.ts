import type { Telegram } from "telegraf";
import { Markup } from "telegraf";
import { formatResult, type Feature } from "./format.js";
import type { JobEnvelope } from "./vms.js";

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
]);

/**
 * Deliver a finished VMS job to a Telegram chat. Host-agnostic: works from
 * Lambda B (webhook) and from the local runner (after polling).
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

  const { messages, document } = formatResult(job, feature);

  if (document) {
    await telegram.sendDocument(
      chatId,
      { source: Buffer.from(document.content, "utf-8"), filename: document.filename },
      { caption: document.caption, parse_mode: "HTML", ...MAIN_MENU },
    );
    return;
  }

  for (let i = 0; i < messages.length; i++) {
    const isLast = i === messages.length - 1;
    await telegram.sendMessage(chatId, messages[i]!, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(isLast ? MAIN_MENU : {}),
    });
  }
}
