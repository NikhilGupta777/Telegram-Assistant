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
/cancel — ❌ Cancel current action (also stops the running job)
/history — 🕘 Your recent jobs
/help — ❓ This message

<b>Features in detail:</b>
🎬 <b>Best Clips</b> — Send your link. Optional: add clip lengths after the link (<code>url 15,45,60</code>).
✂️ <b>Clip Cut</b> — 3-step wizard <i>or</i> send link + times in one go: <code>url 1:00 2:30</code>
📝 <b>Subtitles</b> — Result arrives as a <b>.srt file</b>. Optional: add language code (<code>url hi</code> for Hindi).
⏱ <b>Timestamps</b> — Optional: add instructions after the link (<code>url Make 10 chapters</code>).
⬇️ <b>Download</b> — 2 steps: send link, then choose <b>Video (MP4)</b> or <b>Audio (MP3)</b>.

<b>Clip Cut time formats:</b>
• Seconds: <code>90</code>
• MM:SS: <code>1:30</code>
• HH:MM:SS: <code>0:01:30</code>`;
