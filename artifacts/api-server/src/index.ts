import app from "./app.js";
import { logger } from "./lib/logger.js";
import { bot } from "./bot.js";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const WEBHOOK_PATH = "/api/telegram/webhook";

async function startBot() {
  const domain =
    process.env["REPLIT_DEV_DOMAIN"] ??
    (process.env["REPLIT_DOMAINS"] ?? "").split(",")[0]?.trim();

  if (!domain) {
    logger.error("No public domain found; bot cannot use webhook mode");
    return;
  }

  const webhookUrl = `https://${domain}${WEBHOOK_PATH}`;

  try {
    await bot.telegram.setWebhook(webhookUrl, { drop_pending_updates: true });
    logger.info({ webhookUrl }, "Telegram webhook set");

    app.use(WEBHOOK_PATH, bot.webhookCallback(WEBHOOK_PATH));
    logger.info("Telegram bot ready (webhook mode)");
  } catch (err) {
    logger.error({ err }, "Failed to set Telegram webhook");
  }
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }
  logger.info({ port }, "Server listening");
  void startBot();
});

process.once("SIGINT", () => {
  bot.telegram.deleteWebhook().catch(() => null);
});
process.once("SIGTERM", () => {
  bot.telegram.deleteWebhook().catch(() => null);
});
