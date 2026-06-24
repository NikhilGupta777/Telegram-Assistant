import https from "node:https";
import { config } from "dotenv";

config({ path: "./.env" });

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("No TELEGRAM_BOT_TOKEN found in .env");
  process.exit(1);
}

const commands = [
  { command: "start", description: "Main menu" },
  { command: "help", description: "How to use this bot" },
  { command: "cancel", description: "Cancel current action" },
  { command: "cut", description: "Clip Cut" },
  { command: "subtitles", description: "Subtitles" },
  { command: "timestamps", description: "AI Timestamps" },
  { command: "download", description: "Download Video/Audio" }
];

const payload = JSON.stringify({ commands });
const req = https.request(`https://api.telegram.org/bot${token}/setMyCommands`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  }
}, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => console.log(data));
});

req.write(payload);
req.end();
