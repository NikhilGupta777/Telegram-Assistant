import { fmtTime, isYouTubeUrl, parseSeconds, esc, type Feature } from "./format.js";

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
  /** message_id of the last bot prompt — used by the adapter for edit-in-place. */
  botMessageId?: number;
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
  replies: { text: string; keyboard?: Keyboard; forceReply?: boolean }[];
  /** New session state to persist (null = clear session). */
  session: SessionState | null;
  /** If set, the adapter must start this VMS job. */
  startJob?: { feature: Feature; endpoint: string; payload: Record<string, unknown> };
}

const URL_HINT = `<code>https://youtu.be/abc123</code>`;

// ─── Feature entry points (called from button taps) ──────────────────────────

export function startFeature(feature: Feature): FlowAction {
  switch (feature) {
    case "clips":
      return {
        session: { feature, step: "clips_url", data: {} },
        replies: [
          {
            text: `🎬 <b>Best Clips</b>\n\nStep 1 of 1 — Send your YouTube link:\n\n${URL_HINT}\n\n<i>Optional: add clip lengths (seconds) after the link:\n<code>https://youtu.be/abc123  15,45,60</code></i>`,
            keyboard: "cancel",
            forceReply: true,
          },
        ],
      };
    case "cut":
      return {
        session: { feature, step: "cut_url", data: {} },
        replies: [
          {
            text: `✂️ <b>Clip Cut</b>\n\n<b>Step 1 of 3</b> — Send your YouTube link:\n\n${URL_HINT}\n\n<i>Shortcut: send link + start + end in one go:\n<code>https://youtu.be/abc123  1:00  2:30</code></i>`,
            keyboard: "cancel",
            forceReply: true,
          },
        ],
      };
    case "subtitles":
      return {
        session: { feature, step: "subtitles_url", data: {} },
        replies: [
          {
            text: `📝 <b>Subtitles</b>\n\nStep 1 of 1 — Send your YouTube link:\n\n${URL_HINT}\n\n<i>Result arrives as a .srt file.\nOptional: add a language code for translation:\n<code>https://youtu.be/abc123  hi</code> (Hindi)\n<code>https://youtu.be/abc123  en</code> (English)</i>`,
            keyboard: "cancel",
            forceReply: true,
          },
        ],
      };
    case "timestamps":
      return {
        session: { feature, step: "timestamps_url", data: {} },
        replies: [
          {
            text: `⏱ <b>AI Timestamps</b>\n\nStep 1 of 1 — Send your YouTube link:\n\n${URL_HINT}\n\n<i>Optional: add instructions after the link:\n<code>https://youtu.be/abc123  Make 10 detailed chapters</code></i>`,
            keyboard: "cancel",
            forceReply: true,
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
            forceReply: true,
          },
        ],
      };
  }
}

// ─── Text-message handler (the step machine) ─────────────────────────────────

const INVALID_URL_MSG = `❌ Please send a valid YouTube URL:\n${URL_HINT}`;
const INVALID_TIME_MSG = (eg1: string, eg2: string, eg3: string) =>
  `❌ <b>Invalid time</b>\n\nAccepted formats:\n• MM:SS → <code>${eg1}</code>\n• Seconds → <code>${eg2}</code>\n• HH:MM:SS → <code>${eg3}</code>`;
const MAX_CLIP_DURATION_S = 780; // VMS limit: 13 min

/** Pure: given current session + incoming text, return the next action. */
export function handleText(session: SessionState, text: string): FlowAction {
  const t = text.trim();

  if (!session.step) {
    const parts = t.split(/\s+/);
    const url = parts[0] ?? "";

    // Auto-detect Cut shortcut: URL + start + end
    if (parts.length >= 3 && isYouTubeUrl(url)) {
      const start = parseSeconds(parts[1] ?? "");
      const end = parseSeconds(parts[2] ?? "");
      if (start !== null && end !== null) {
        if (end <= start) {
          return keep(
            session,
            `❌ End time must be <b>after</b> start time.\n\nStart: <code>${fmtTime(start)}</code>  End: <code>${fmtTime(end)}</code>\n\nSend all three values again:`,
            "cancel",
          );
        }
        if (end - start > MAX_CLIP_DURATION_S) {
          return keep(
            session,
            `❌ Clip too long — maximum is <b>13 minutes</b>.\n\nSend all three values again with a shorter range:`,
            "cancel",
          );
        }
        return {
          session: null,
          replies: [],
          startJob: {
            feature: "cut",
            endpoint: "clip-cut",
            payload: { url, startTime: start, endTime: end },
          },
        };
      }
    }

    return {
      session: session, // unchanged
      replies: [{ text: "👇 Choose a feature to get started:", keyboard: "main" }],
    };
  }

  switch (session.step) {
    // ── Clip Cut: 3-step form (with single-line shortcut) ─────────────────
    case "cut_url": {
      const parts = t.split(/\s+/);
      const url = parts[0] ?? "";
      if (!isYouTubeUrl(url)) return keep(session, INVALID_URL_MSG, "cancel");

      // Single-line shortcut: url start end all at once
      if (parts.length >= 3) {
        const start = parseSeconds(parts[1] ?? "");
        const end = parseSeconds(parts[2] ?? "");
        if (start !== null && end !== null) {
          if (end <= start) {
            return keep(
              session,
              `❌ End time must be <b>after</b> start time.\n\nStart: <code>${fmtTime(start)}</code>  End: <code>${fmtTime(end)}</code>\n\nSend all three values again:`,
              "cancel",
            );
          }
          if (end - start > MAX_CLIP_DURATION_S) {
            return keep(
              session,
              `❌ Clip too long — maximum is <b>13 minutes</b>.\n\nSend all three values again with a shorter range:`,
              "cancel",
            );
          }
          // No wizard confirmation reply — Lambda A's onStartJob sends a
          // single status message via formatJobStart that auto-deletes on
          // result delivery. The wizard's "✅ Cutting clip From X to Y"
          // message used to linger forever and visually duplicate the
          // status message; dropping it keeps the chat clean.
          return {
            session: null,
            replies: [],
            startJob: {
              feature: "cut",
              endpoint: "clip-cut",
              payload: { url, startTime: start, endTime: end },
            },
          };
        }
      }

      // Normal wizard path: URL only → ask for start time
      return {
        session: { ...session, step: "cut_start", data: { url } },
        replies: [
          {
            text: `✂️ <b>Clip Cut</b>\n\n<b>Step 2 of 3</b> — Send the <b>start time</b>:\n\nExamples: <code>1:23</code>  or  <code>83</code>  or  <code>0:01:23</code>`,
            keyboard: "cancel",
            forceReply: true,
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
            forceReply: true,
          },
        ],
      };
    }
    case "cut_end": {
      const end = parseSeconds(t);
      const start = session.data?.["startTime"] as number | undefined;
      const url = session.data?.["url"] as string | undefined;
      // Session lost its earlier answers (expired/cleared) — restart cleanly
      // instead of starting a job with undefined start/url.
      if (start === undefined || url === undefined) {
        return {
          session: null,
          replies: [
            { text: "⚠️ Session expired. Please start again:", keyboard: "main" },
          ],
        };
      }
      if (end === null)
        return keep(session, INVALID_TIME_MSG("2:45", "165", "0:02:45"), "cancel");
      if (end <= start) {
        return keep(
          session,
          `❌ End time must be <b>after</b> start time.\n\nStart: <code>${fmtTime(start)}</code>\nYour end: <code>${fmtTime(end)}</code>\n\nSend a later end time:`,
          "cancel",
        );
      }
      if (end - start > MAX_CLIP_DURATION_S) {
        return keep(
          session,
          `❌ Clip too long — maximum is <b>13 minutes</b>.\n\nStart: <code>${fmtTime(start)}</code>. Send a closer end time:`,
          "cancel",
        );
      }
      return {
        session: null,
        replies: [],
        startJob: {
          feature: "cut",
          endpoint: "clip-cut",
          payload: { url, startTime: start, endTime: end },
        },
      };
    }

    // ── Download: URL then button choice ───────────────────────────────────
    case "download_url": {
      if (!isYouTubeUrl(t)) return keep(session, INVALID_URL_MSG, "cancel");
      return {
        session: { ...session, step: "download_type", data: { url: t } },
        replies: [
          {
            text: `⬇️ <b>Step 2 of 2</b> — What do you want to download?\n\n<code>${esc(t)}</code>`,
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
      if (!isYouTubeUrl(url)) return keep(session, INVALID_URL_MSG, "cancel");
      const durStr = parts[1];
      const durations =
        durStr
          ?.split(",")
          .map(Number)
          .filter((n) => Number.isFinite(n) && n > 0) ?? [];
      return {
        session: null,
        replies: [],
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
      const parts = t.split(/\s+/);
      const url = parts[0] ?? "";
      if (!isYouTubeUrl(url)) return keep(session, INVALID_URL_MSG, "cancel");
      const lang = parts[1]?.trim().toLowerCase() || "auto";
      return {
        session: null,
        replies: [],
        startJob: {
          feature: "subtitles",
          endpoint: "subtitles",
          payload: { url, language: lang },
        },
      };
    }
    case "timestamps_url": {
      const spaceIdx = t.indexOf(" ");
      const url = spaceIdx !== -1 ? t.slice(0, spaceIdx) : t;
      if (!isYouTubeUrl(url)) return keep(session, INVALID_URL_MSG, "cancel");
      const instructions = spaceIdx !== -1 ? t.slice(spaceIdx + 1).trim() : undefined;
      return {
        session: null,
        replies: [],
        startJob: {
          feature: "timestamps",
          endpoint: "timestamps",
          payload: { url, ...(instructions ? { instructions } : {}) },
        },
      };
    }
  }

  // Defensive: an unrecognised/corrupt stored step — reset to the menu rather
  // than returning undefined (which would crash the adapter).
  return {
    session: null,
    replies: [{ text: "👇 Choose a feature to get started:", keyboard: "main" }],
  };
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
    replies: [],
    startJob: {
      feature: "download",
      endpoint: "download",
      payload: { url, audioOnly },
    },
  };
}

function keep(session: SessionState, text: string, keyboard: Keyboard): FlowAction {
  return { session, replies: [{ text, keyboard, forceReply: true }] };
}
