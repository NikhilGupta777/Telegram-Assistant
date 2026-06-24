import { describe, it, expect } from "vitest";
import {
  parseSeconds,
  fmtTime,
  isValidUrl,
  isYouTubeUrl,
  esc,
  chunkMessage,
  formatResult,
  friendlyError,
  TG_MAX,
} from "../src/format.js";
import type { JobEnvelope } from "../src/vms.js";

describe("parseSeconds", () => {
  it("parses plain seconds", () => {
    expect(parseSeconds("83")).toBe(83);
    expect(parseSeconds("0")).toBe(0);
    expect(parseSeconds(" 90 ")).toBe(90);
  });
  it("parses MM:SS", () => {
    expect(parseSeconds("1:23")).toBe(83);
    expect(parseSeconds("0:30")).toBe(30);
    expect(parseSeconds("10:00")).toBe(600);
  });
  it("parses HH:MM:SS", () => {
    expect(parseSeconds("0:01:23")).toBe(83);
    expect(parseSeconds("1:00:00")).toBe(3600);
    expect(parseSeconds("2:03:04")).toBe(7384);
  });
  it("rejects invalid input", () => {
    expect(parseSeconds("")).toBeNull();
    expect(parseSeconds("abc")).toBeNull();
    expect(parseSeconds("1:99")).toBeNull(); // seconds >= 60
    expect(parseSeconds("1:60:00")).toBeNull(); // minutes >= 60
    expect(parseSeconds("-5")).toBeNull();
    expect(parseSeconds("1:2:3:4")).toBeNull();
  });
});

describe("fmtTime", () => {
  it("formats under an hour as M:SS", () => {
    expect(fmtTime(83)).toBe("1:23");
    expect(fmtTime(0)).toBe("0:00");
    expect(fmtTime(5)).toBe("0:05");
  });
  it("formats over an hour as H:MM:SS", () => {
    expect(fmtTime(3600)).toBe("1:00:00");
    expect(fmtTime(7384)).toBe("2:03:04");
  });
  it("is robust to bad input", () => {
    expect(fmtTime(-1)).toBe("0:00");
    expect(fmtTime(NaN)).toBe("0:00");
  });
  it("round-trips with parseSeconds", () => {
    for (const s of [0, 5, 59, 60, 83, 600, 3600, 7384]) {
      expect(parseSeconds(fmtTime(s))).toBe(s);
    }
  });
});

describe("isValidUrl", () => {
  it("accepts any http/https URL", () => {
    expect(isValidUrl("https://youtu.be/abc")).toBe(true);
    expect(isValidUrl("http://example.com")).toBe(true);
    expect(isValidUrl("  https://x.com/y  ")).toBe(true);
  });
  it("rejects non-urls and other protocols", () => {
    expect(isValidUrl("not a url")).toBe(false);
    expect(isValidUrl("ftp://x.com")).toBe(false);
    expect(isValidUrl("javascript:alert(1)")).toBe(false);
    expect(isValidUrl("")).toBe(false);
  });
});

describe("isYouTubeUrl", () => {
  it("accepts youtube.com variants", () => {
    expect(isYouTubeUrl("https://www.youtube.com/watch?v=abc")).toBe(true);
    expect(isYouTubeUrl("https://youtube.com/watch?v=abc")).toBe(true);
    expect(isYouTubeUrl("https://m.youtube.com/watch?v=abc")).toBe(true);
    expect(isYouTubeUrl("http://youtube.com/watch?v=abc")).toBe(true);
  });
  it("accepts youtu.be short links", () => {
    expect(isYouTubeUrl("https://youtu.be/abc123")).toBe(true);
    expect(isYouTubeUrl("  https://youtu.be/abc  ")).toBe(true);
  });
  it("rejects non-YouTube URLs", () => {
    expect(isYouTubeUrl("https://vimeo.com/123")).toBe(false);
    expect(isYouTubeUrl("https://example.com")).toBe(false);
    expect(isYouTubeUrl("https://fakeyoutube.com/watch")).toBe(false);
    expect(isYouTubeUrl("https://youtu.be.evil.com/abc")).toBe(false);
  });
  it("rejects non-http protocols and plain text", () => {
    expect(isYouTubeUrl("ftp://youtube.com/watch")).toBe(false);
    expect(isYouTubeUrl("youtube.com/watch")).toBe(false);
    expect(isYouTubeUrl("not a url")).toBe(false);
    expect(isYouTubeUrl("")).toBe(false);
  });
});

describe("esc", () => {
  it("escapes HTML-significant chars including quotes", () => {
    expect(esc(`<a href="x">&</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;",
    );
  });
  it("prevents href attribute breakout", () => {
    const url = `https://x.com/"><script>`;
    const html = `<a href="${esc(url)}">link</a>`;
    expect(html).not.toContain(`"><script>`);
  });
});

describe("chunkMessage", () => {
  it("returns a single chunk when short", () => {
    expect(chunkMessage("hello")).toEqual(["hello"]);
  });
  it("splits long text under the limit", () => {
    const line = "x".repeat(100);
    const text = Array.from({ length: 100 }, () => line).join("\n");
    const chunks = chunkMessage(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(TG_MAX);
  });
  it("hard-splits a single overlong line", () => {
    const chunks = chunkMessage("y".repeat(10000), 4000);
    expect(chunks.length).toBe(3);
    expect(chunks.join("")).toBe("y".repeat(10000));
  });
});

describe("formatResult", () => {
  const base: JobEnvelope = { jobId: "j1", status: "done", succeeded: true };

  it("formats a failed job", () => {
    const r = formatResult(
      { jobId: "j", status: "error", failed: true, message: "boom" },
      "clips",
    );
    expect(r.messages[0]).toContain("Job failed");
    expect(r.messages[0]).toContain("boom");
  });

  it("formats clips", () => {
    const r = formatResult(
      {
        ...base,
        result: { clips: [{ title: "Great", start: 10, end: 40, reason: "viral" }] },
      },
      "clips",
    );
    expect(r.messages[0]).toContain("Best Clips Found");
    expect(r.messages[0]).toContain("Great");
    expect(r.messages[0]).toContain("0:10");
  });

  it("caps oversize clip lists into multiple messages", () => {
    const clips = Array.from({ length: 400 }, (_, i) => ({
      title: `Clip number ${i} with a fairly long descriptive title here`,
      start: i,
      end: i + 30,
      reason: "x".repeat(120),
    }));
    const r = formatResult({ ...base, result: { clips } }, "clips");
    expect(r.messages.length).toBeGreaterThan(1);
    for (const m of r.messages) expect(m.length).toBeLessThanOrEqual(TG_MAX);
  });

  it("formats a download/cut url", () => {
    const r = formatResult(
      { ...base, result: { url: "https://cdn/x.mp4" } },
      "download",
    );
    expect(r.messages[0]).toContain("https://cdn/x.mp4");
  });

  it("returns srt as a document", () => {
    const r = formatResult(
      { ...base, result: { srt: "1\n00:00:00 --> 00:00:01\nhi" } },
      "subtitles",
    );
    expect(r.document?.filename).toBe("subtitles.srt");
    expect(r.messages).toHaveLength(0);
  });

  it("attaches long transcripts as a file", () => {
    const r = formatResult(
      { ...base, result: { transcript: "word ".repeat(2000) } },
      "subtitles",
    );
    expect(r.document?.filename).toBe("transcript.txt");
  });

  it("formats timestamps", () => {
    const r = formatResult(
      {
        ...base,
        result: { timestamps: [{ time: 0, label: "Intro" }, { time: 65, label: "Part 2" }] },
      },
      "timestamps",
    );
    expect(r.messages[0]).toContain("Intro");
    expect(r.messages[0]).toContain("1:05");
  });

  it("rawFallback uses a friendly wrapper instead of bare JSON", () => {
    const r = formatResult({ ...base, result: { weird: "shape" } }, "clips");
    expect(r.messages[0]).toContain("Done!");
    expect(r.messages[0]).toContain("couldn't format it nicely");
    expect(r.messages[0]).toContain("weird");
  });
});

describe("friendlyError", () => {
  it("maps known codes", () => {
    expect(friendlyError("RATE_LIMIT_EXCEEDED", "x")).toContain("fast");
    expect(friendlyError("MONTHLY_QUOTA_EXCEEDED", "x")).toContain("quota");
  });
  it("falls back for unknown codes", () => {
    expect(friendlyError(undefined, "fallback")).toBe("fallback");
    expect(friendlyError("WEIRD", "fallback")).toBe("fallback");
  });
});
