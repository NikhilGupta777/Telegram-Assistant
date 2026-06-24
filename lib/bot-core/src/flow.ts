import { fmtTime, isValidUrl, parseSeconds, type Feature } from "./format.js";

// ─── Session state ───────────────────────────────────────────────────────────

export type Step =
  | "clips_url"
  | "cut_url"
  | "cut_start"
  | "cut_end"
  | "subtitles_url"
  | "timestamps_url"
  | "download_url"
  | "download_type";

export interface SessionState {
  feature?: Feature;
  step?: Step;
  data?: Record<string, unknown>;
  expiresAt?: number;
}

export const SESSION_TTL = 30 * 60 * 1000;

// ─── Flow result ─────────────────────────────────────────────────────────────

export type Keyboard = "cancel" | "main" | "download_type" | "none";

/**
 * A pure description of what the bot should do next. The Telegraf/Lambda
 * adapter turns this into actual API calls — the flow itself has no I/O,
 * which makes the whole conversation testable.
 */
export interface FlowAction {
  /** Reply text(s) to send, in order. HTML parse mode. */
  replies: { text: string; keyboard?: Keyboard }[];
  /** New session state to persist (null = clear session). */
  session: SessionState | null;
  /** If set, the adapter must start this VMS job. */
  startJob?: { feature: Feature; endpoint: string; payload: Record<string, unknown> };
}

const URL_HINT = `<code>https://youtu.be/abc123</code>`;

function reply(text: string, keyboard: Keyboard = "none") {
  return { replies: [{ text, keyboard }], session: undefined as never };
}

// ─── Feature entry points (called from button taps) ──────────────────────────

export function startFeature(feature: Feature): FlowAction {
  switch (feature) {
    case "clips":
      return {
        session: { feature, step: "clips_url", data: {} },
        replies: [
          {
            text: `🎬 <b>Best Clips</b>\n\nStep 1 of 1 — Send your YouTube link:\n\n${URL_HINT}`,
            keyboard: "cancel",
          },
        ],
      };
    case "cut":
      return {
        session: { feature, step: "cut_url", data: {} },
        replies: [
          {
            text: `✂️ <b>Clip Cut</b>\n\n<b>Step 1 of 3</b> — Send your YouTube link:\n\n${URL_HINT}`,
            keyboard: "cancel",
          },
        ],
      };
    case "subtitles":
      return {
        session: { feature, step: "subtitles_url", data: {} },
        replies: [
          {
            text: `📝 <b>Subtitles</b>\n\nStep 1 of 1 — Send your YouTube link:\n\n${URL_HINT}\n\n<i>Subtitles will be sent as a .srt file</i>`,
            keyboard: "cancel",
          },
        ],
      };
    case "timestamps":
      return {
        session: { feature, step: "timestamps_url", data: {} },
        replies: [
          {
            text: `⏱ <b>AI Timestamps</b>\n\nStep 1 of 1 — Send your YouTube link:\n\n${URL_HINT}\n\n<i>Optionally add instructions after the link:\n<code>https://youtu.be/abc123  Make 10 detailed chapters</code></i>`,
            keyboard: "cancel",
          },
        ],
      };
    case "download":
      return {
        session: { feature, step: "download_url", data: {} },
        replies: [
          {
            text: `⬇️ <b>Download</b>\n\nStep 1 of 2 — Send your YouTube link:\n\n${URL_HINT}`,
            keyboard: "cancel",
          },
        ],
      };
  }
}

// ─── Text-message handler (the step machine) ─────────────────────────────────

const INVALID_URL_MSG = `❌ Please send a valid YouTube URL:\n${URL_HINT}`;
const INVALID_TIME_MSG = (eg1: string, eg2: string, eg3: string) =>
  `❌ <b>Invalid time</b>\n\nAccepted formats:\n• MM:SS → <code>${eg1}</code>\n• Seconds → <code>${eg2}</code>\n• HH:MM:SS → <code>${eg3}</code>`;

/** Pure: given current session + incoming text, return the next action. */
export function handleText(session: SessionState, text: string): FlowAction {
  const t = text.trim();

  if (!session.step) {
    return {
      session: session, // unchanged
      replies: [{ text: "👇 Choose a feature to get started:", keyboard: "main" }],
    };
  }

  switch (session.step) {
    // ── Clip Cut: 3-step form ──────────────────────────────────────────────
    case "cut_url": {
      if (!isValidUrl(t)) return keep(session, INVALID_URL_MSG, "cancel");
      return {
        session: { ...session, step: "cut_start", data: { url: t } },
        replies: [
          {
            text: `✂️ <b>Clip Cut</b>\n\n<b>Step 2 of 3</b> — Send the <b>start time</b>:\n\nExamples: <code>1:23</code>  or  <code>83</code>  or  <code>0:01:23</code>`,
            keyboard: "cancel",
          },
        ],
      };
    }
    case "cut_start": {
      const start = parseSeconds(t);
      if (start === null)
        return keep(session, INVALID_TIME_MSG("1:23", "83", "0:01:23"), "cancel");
      return {
        session: { ...session, step: "cut_end", data: { ...session.data, startTime: start } },
        replies: [
          {
            text: `✂️ <b>Clip Cut</b>\n\n<b>Step 3 of 3</b> — Send the <b>end time</b>:\n\nStart: <code>${fmtTime(start)}</code>\nExamples: <code>2:45</code>  or  <code>165</code>  or  <code>0:02:45</code>`,
            keyboard: "cancel",
          },
        ],
      };
    }
    case "cut_end": {
      const end = parseSeconds(t);
      const start = session.data?.["startTime"] as number;
      const url = session.data?.["url"] as string;
      if (end === null)
        return keep(session, INVALID_TIME_MSG("2:45", "165", "0:02:45"), "cancel");
      if (end <= start) {
        return keep(
          session,
          `❌ End time must be <b>after</b> start time.\n\nStart: <code>${fmtTime(start)}</code>\nYour end: <code>${fmtTime(end)}</code>\n\nSend a later end time:`,
          "cancel",
        );
      }
      return {
        session: null,
        replies: [
          {
            text: `✅ <b>Cutting clip</b>\n\nFrom <code>${fmtTime(start)}</code> to <code>${fmtTime(end)}</code> (${fmtTime(end - start)} long)`,
          },
        ],
        startJob: {
          feature: "cut",
          endpoint: "clip-cut",
          payload: { url, startTime: start, endTime: end },
        },
      };
    }

    // ── Download: URL then button choice ───────────────────────────────────
    case "download_url": {
      if (!isValidUrl(t)) return keep(session, INVALID_URL_MSG, "cancel");
      return {
        session: { ...session, step: "download_type", data: { url: t } },
        replies: [
          {
            text: `⬇️ <b>Step 2 of 2</b> — What do you want to download?`,
            keyboard: "download_type",
          },
        ],
      };
    }
    case "download_type": {
      return keep(
        session,
        `👆 Please tap <b>Video</b> or <b>Audio</b> on the message above.`,
        "none",
      );
    }

    // ── Single-step features ───────────────────────────────────────────────
    case "clips_url": {
      const parts = t.split(/\s+/);
      const url = parts[0] ?? "";
      if (!isValidUrl(url)) return keep(session, INVALID_URL_MSG, "cancel");
      const durStr = parts[1];
      const durations =
        durStr
          ?.split(",")
          .map(Number)
          .filter((n) => Number.isFinite(n) && n > 0) ?? [];
      return {
        session: null,
        replies: [{ text: "🎬 Analysing video to find the best clips…" }],
        startJob: {
          feature: "clips",
          endpoint: "clips",
          payload: {
            url,
            durations: durations.length ? durations : [30, 60],
            auto: true,
          },
        },
      };
    }
    case "subtitles_url": {
      const url = t.split(/\s+/)[0] ?? "";
      if (!isValidUrl(url)) return keep(session, INVALID_URL_MSG, "cancel");
      return {
        session: null,
        replies: [{ text: "📝 Generating subtitles…" }],
        startJob: {
          feature: "subtitles",
          endpoint: "subtitles",
          payload: { url, language: "auto" },
        },
      };
    }
    case "timestamps_url": {
      const spaceIdx = t.indexOf(" ");
      const url = spaceIdx !== -1 ? t.slice(0, spaceIdx) : t;
      if (!isValidUrl(url)) return keep(session, INVALID_URL_MSG, "cancel");
      const instructions = spaceIdx !== -1 ? t.slice(spaceIdx + 1).trim() : undefined;
      return {
        session: null,
        replies: [{ text: "⏱ Generating chapter timestamps…" }],
        startJob: {
          feature: "timestamps",
          endpoint: "timestamps",
          payload: { url, ...(instructions ? { instructions } : {}) },
        },
      };
    }
  }
}

/** Download button taps (video/audio). Returns null reply if session lost. */
export function handleDownloadChoice(
  session: SessionState,
  audioOnly: boolean,
): FlowAction {
  const url = session.data?.["url"] as string | undefined;
  if (!url) {
    return {
      session: null,
      replies: [
        { text: "⚠️ Session expired. Please start again:", keyboard: "main" },
      ],
    };
  }
  return {
    session: null,
    replies: [{ text: audioOnly ? "✅ Extracting audio…" : "✅ Downloading video…" }],
    startJob: {
      feature: "download",
      endpoint: "download",
      payload: { url, audioOnly },
    },
  };
}

function keep(session: SessionState, text: string, keyboard: Keyboard): FlowAction {
  return { session, replies: [{ text, keyboard }] };
}
