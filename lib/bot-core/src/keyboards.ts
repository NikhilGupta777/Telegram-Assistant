import { Markup } from "telegraf";
import type { InlineKeyboardMarkup } from "telegraf/types";
import type { Feature } from "./format.js";

type InlineKb = Markup.Markup<InlineKeyboardMarkup>;

/**
 * The bot's home menu. Single source of truth — both the conversational
 * flow (telegram.ts) and the result-delivery layer (deliver.ts) attach
 * this to their replies so users always see the same set of buttons.
 */
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
]);

/**
 * Shown after a job fails (either pre-start or webhook-delivered). One tap
 * re-enters the same feature so the user doesn't have to navigate the menu.
 */
export function retryKb(feature: Feature): InlineKb {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔄 Try Again", `feat:${feature}`)],
    [Markup.button.callback("🏠 Main Menu", "menu")],
  ]);
}
