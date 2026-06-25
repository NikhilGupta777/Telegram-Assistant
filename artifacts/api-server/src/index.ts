import app from "./app.js";
import { logger } from "./lib/logger.js";
import { bot } from "./bot.js";
import type { Request, Response } from "express";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}

const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const WEBHOOK_PATH = "/api/telegram/webhook";

const WEBHOOK_SECRET = process.env["TELEGRAM_WEBHOOK_SECRET"];

app.post(WEBHOOK_PATH, (req: Request, res: Response) => {
  // Reject spoofed updates if a secret is configured.
  if (WEBHOOK_SECRET) {
    const provided = req.header("x-telegram-bot-api-secret-token");
    if (provided !== WEBHOOK_SECRET) {
      res.sendStatus(401);
      return;
    }
  }
  // Ack Telegram immediately; process the update in the background so a long
  // job never blocks the webhook (which would trigger Telegram retries).
  res.sendStatus(200);
  void bot.handleUpdate(req.body).catch((err) => {
    logger.error({ err }, "Error handling Telegram update");
  });
});

async function startBot() {
  const domain =
    process.env["WEBHOOK_DOMAIN"] ??
    process.env["REPLIT_DEV_DOMAIN"] ??
    (process.env["REPLIT_DOMAINS"] ?? "").split(",")[0]?.trim();

  if (!domain) {
    logger.error(
      "No public domain found. Set WEBHOOK_DOMAIN env var (e.g. your-app.koyeb.app)",
    );
    return;
  }

  const webhookUrl = `https://${domain}${WEBHOOK_PATH}`;
  try {
    await bot.telegram.setWebhook(webhookUrl, {
      drop_pending_updates: true,
      ...(WEBHOOK_SECRET ? { secret_token: WEBHOOK_SECRET } : {}),
    });
    logger.info({ webhookUrl }, "Telegram webhook set — bot ready");
  } catch (err) {
    logger.error({ err }, "Failed to set Telegram webhook");
  }

  try {
    await bot.telegram.setMyCommands([
      { command: "start", description: "🏠 Main menu" },
      { command: "help", description: "❓ How to use this bot" },
      { command: "history", description: "🕘 Your recent jobs" },
      { command: "cancel", description: "❌ Cancel current action" },
    ]);
    logger.info("Bot commands registered");
  } catch (err) {
    logger.error({ err }, "Failed to set bot commands");
  }
}

// Note: Express's listen callback receives no error argument — listen errors
// (e.g. EADDRINUSE) are emitted as an 'error' event on the server, so handle
// them there rather than in the callback.
const server = app.listen(port, () => {
  logger.info({ port }, "Server listening");
  void startBot();
});

server.on("error", (err) => {
  logger.error({ err }, "Error listening on port");
  process.exit(1);
});

process.once("SIGINT", () => bot.telegram.deleteWebhook().catch(() => null));
process.once("SIGTERM", () => bot.telegram.deleteWebhook().catch(() => null));
