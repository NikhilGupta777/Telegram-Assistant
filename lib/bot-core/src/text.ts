/** Shared user-facing copy used by both the Lambda and local runner. */

/** Rotating progress messages for the inline-polling (local) mode. */
export const PROGRESS_MSGS = [
  "Analysing video…",
  "AI is working its magic…",
  "Processing…",
  "Almost done…",
  "Finalising results…",
];

export const WELCOME = `🙏 <b>Narayan Bhakt Editor</b>

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

export const HELP = `🙏 <b>How to use Narayan Bhakt Editor</b>

1️⃣ Tap a feature button
2️⃣ Follow the prompts step by step
3️⃣ Paste your YouTube link when asked
4️⃣ Wait for your result (30s – 3 min)

<b>Commands:</b>
/start — 🏠 Main menu
/cancel — ❌ Cancel current action
/history — 🕘 Your recent jobs
/help — ❓ This message

<b>Clip Cut time formats:</b>
• Seconds: <code>90</code>
• MM:SS: <code>1:30</code>
• HH:MM:SS: <code>0:01:30</code>`;
