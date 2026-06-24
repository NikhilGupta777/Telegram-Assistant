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

Your AI-powered video studio. Tap a feature to begin:

🎬 <b>Best Clips</b> — Find viral moments automatically
✂️ <b>Clip Cut</b> — Cut any section of a video
📝 <b>Subtitles</b> — Generate subtitles &amp; transcript
⏱ <b>Timestamps</b> — Auto-generate YouTube chapters
⬇️ <b>Download</b> — Download YouTube videos`;

export const HELP = `🙏 <b>How it works</b>

Tap a feature → follow the prompts → paste your YouTube link → get your result (usually 30 s – 3 min).

<b>Commands</b>
/start — 🏠 Main menu
/cancel — ❌ Stop the current job
/history — 🕘 Your recent jobs
/help — ❓ This message

<b>Shortcuts (one-liner instead of the wizard)</b>
✂️ Clip Cut — <code>url 1:00 2:30</code>
🎬 Best Clips — <code>url 15,45,60</code> (clip lengths in seconds)
📝 Subtitles — <code>url hi</code> (target language code)
⏱ Timestamps — <code>url Make 10 chapters</code>

<b>Time formats accepted</b>
<code>90</code> · <code>1:30</code> · <code>0:01:30</code>`;
