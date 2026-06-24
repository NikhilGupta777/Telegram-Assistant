import { describe, it, expect } from "vitest";
import {
  startFeature,
  handleText,
  handleDownloadChoice,
  type SessionState,
} from "../src/flow.js";

describe("startFeature", () => {
  it("sets the right first step per feature", () => {
    expect(startFeature("clips").session?.step).toBe("clips_url");
    expect(startFeature("cut").session?.step).toBe("cut_url");
    expect(startFeature("subtitles").session?.step).toBe("subtitles_url");
    expect(startFeature("timestamps").session?.step).toBe("timestamps_url");
    expect(startFeature("download").session?.step).toBe("download_url");
  });
});

describe("clip cut 3-step wizard", () => {
  it("walks url → start → end → startJob", () => {
    let s: SessionState = startFeature("cut").session!;

    const a1 = handleText(s, "https://youtu.be/abc");
    expect(a1.session?.step).toBe("cut_start");
    s = a1.session!;

    const a2 = handleText(s, "1:00");
    expect(a2.session?.step).toBe("cut_end");
    expect(a2.session?.data?.["startTime"]).toBe(60);
    s = a2.session!;

    const a3 = handleText(s, "2:00");
    expect(a3.session).toBeNull(); // cleared
    expect(a3.startJob).toEqual({
      feature: "cut",
      endpoint: "clip-cut",
      payload: { url: "https://youtu.be/abc", startTime: 60, endTime: 120 },
    });
  });

  it("rejects a non-YouTube url at step 1", () => {
    const s = startFeature("cut").session!;
    const a = handleText(s, "https://vimeo.com/123");
    expect(a.startJob).toBeUndefined();
    expect(a.replies[0]!.text).toContain("valid YouTube URL");
    expect(a.session?.step).toBe("cut_url"); // unchanged
  });

  it("rejects a plain non-url at step 1", () => {
    const s = startFeature("cut").session!;
    const a = handleText(s, "nope");
    expect(a.startJob).toBeUndefined();
    expect(a.replies[0]!.text).toContain("valid YouTube URL");
    expect(a.session?.step).toBe("cut_url");
  });

  it("rejects end <= start", () => {
    let s = startFeature("cut").session!;
    s = handleText(s, "https://youtu.be/abc").session!;
    s = handleText(s, "1:00").session!;
    const a = handleText(s, "0:30");
    expect(a.startJob).toBeUndefined();
    expect(a.replies[0]!.text).toContain("after");
    expect(a.session?.step).toBe("cut_end"); // stays to retry
  });

  it("rejects clips longer than 13 minutes", () => {
    let s = startFeature("cut").session!;
    s = handleText(s, "https://youtu.be/abc").session!;
    s = handleText(s, "0:00").session!;
    const a = handleText(s, "13:01"); // 781 s > 780
    expect(a.startJob).toBeUndefined();
    expect(a.replies[0]!.text).toContain("13 minutes");
    expect(a.session?.step).toBe("cut_end");
  });

  it("rejects an unparseable time", () => {
    let s = startFeature("cut").session!;
    s = handleText(s, "https://youtu.be/abc").session!;
    const a = handleText(s, "abc");
    expect(a.session?.step).toBe("cut_start");
    expect(a.replies[0]!.text).toContain("Invalid time");
  });
});

describe("clip cut single-line shortcut", () => {
  it("accepts url start end in one message and fires the job", () => {
    const s = startFeature("cut").session!;
    const a = handleText(s, "https://youtu.be/abc 1:00 2:30");
    expect(a.session).toBeNull();
    expect(a.startJob).toEqual({
      feature: "cut",
      endpoint: "clip-cut",
      payload: { url: "https://youtu.be/abc", startTime: 60, endTime: 150 },
    });
  });

  it("shortcut: rejects end <= start", () => {
    const s = startFeature("cut").session!;
    const a = handleText(s, "https://youtu.be/abc 2:00 1:00");
    expect(a.startJob).toBeUndefined();
    expect(a.replies[0]!.text).toContain("after");
    expect(a.session?.step).toBe("cut_url");
  });

  it("shortcut: rejects clips longer than 13 minutes", () => {
    const s = startFeature("cut").session!;
    const a = handleText(s, "https://youtu.be/abc 0:00 13:01");
    expect(a.startJob).toBeUndefined();
    expect(a.replies[0]!.text).toContain("13 minutes");
    expect(a.session?.step).toBe("cut_url");
  });

  it("shortcut: falls through to wizard when third token is not a valid time", () => {
    const s = startFeature("cut").session!;
    // Second token is valid, third is not — treat as URL-only (fall to wizard)
    const a = handleText(s, "https://youtu.be/abc 1:00 notaTime");
    // Should move to cut_start step (wizard path)
    expect(a.session?.step).toBe("cut_start");
    expect(a.startJob).toBeUndefined();
  });
});

describe("download flow", () => {
  it("url then button choice starts the right job", () => {
    let s = startFeature("download").session!;
    const a1 = handleText(s, "https://youtu.be/abc");
    expect(a1.session?.step).toBe("download_type");
    s = a1.session!;

    const video = handleDownloadChoice(s, false);
    expect(video.startJob?.payload).toEqual({
      url: "https://youtu.be/abc",
      audioOnly: false,
    });

    const audio = handleDownloadChoice(s, true);
    expect(audio.startJob?.payload).toEqual({
      url: "https://youtu.be/abc",
      audioOnly: true,
    });
  });

  it("download confirmation includes URL and type", () => {
    let s = startFeature("download").session!;
    s = handleText(s, "https://youtu.be/abc").session!;
    const video = handleDownloadChoice(s, false);
    expect(video.replies[0]!.text).toContain("https://youtu.be/abc");
    expect(video.replies[0]!.text).toContain("Video");
    const audio = handleDownloadChoice(s, true);
    expect(audio.replies[0]!.text).toContain("Audio");
  });

  it("nudges the user to tap a button while on download_type", () => {
    let s = startFeature("download").session!;
    s = handleText(s, "https://youtu.be/abc").session!;
    const a = handleText(s, "random text");
    expect(a.replies[0]!.text).toContain("tap");
    expect(a.startJob).toBeUndefined();
  });

  it("recovers gracefully if the session lost the url", () => {
    const a = handleDownloadChoice({ step: "download_type", data: {} }, false);
    expect(a.startJob).toBeUndefined();
    expect(a.replies[0]!.text).toContain("Session expired");
    expect(a.session).toBeNull();
  });

  it("rejects non-YouTube URL at download_url step", () => {
    const s = startFeature("download").session!;
    const a = handleText(s, "https://vimeo.com/123");
    expect(a.startJob).toBeUndefined();
    expect(a.replies[0]!.text).toContain("valid YouTube URL");
  });
});

describe("single-step features", () => {
  it("clips: defaults durations and starts the job", () => {
    const s = startFeature("clips").session!;
    const a = handleText(s, "https://youtu.be/abc");
    expect(a.startJob?.payload).toMatchObject({
      url: "https://youtu.be/abc",
      durations: [30, 60],
      auto: true,
    });
  });

  it("clips: parses custom durations", () => {
    const s = startFeature("clips").session!;
    const a = handleText(s, "https://youtu.be/abc 15,45");
    expect(a.startJob?.payload).toMatchObject({ durations: [15, 45] });
  });

  it("clips: rejects non-YouTube URL", () => {
    const s = startFeature("clips").session!;
    const a = handleText(s, "https://vimeo.com/123");
    expect(a.startJob).toBeUndefined();
    expect(a.replies[0]!.text).toContain("valid YouTube URL");
  });

  it("subtitles: starts with language auto by default", () => {
    const s = startFeature("subtitles").session!;
    const a = handleText(s, "https://youtu.be/abc");
    expect(a.startJob?.payload).toEqual({
      url: "https://youtu.be/abc",
      language: "auto",
    });
  });

  it("subtitles: respects inline language code", () => {
    const s = startFeature("subtitles").session!;
    const a = handleText(s, "https://youtu.be/abc hi");
    expect(a.startJob?.payload).toEqual({
      url: "https://youtu.be/abc",
      language: "hi",
    });
  });

  it("subtitles: language code is lowercased", () => {
    const s = startFeature("subtitles").session!;
    const a = handleText(s, "https://youtu.be/abc EN");
    expect(a.startJob?.payload).toMatchObject({ language: "en" });
  });

  it("subtitles: rejects non-YouTube URL", () => {
    const s = startFeature("subtitles").session!;
    const a = handleText(s, "not-a-url");
    expect(a.startJob).toBeUndefined();
    expect(a.replies[0]!.text).toContain("valid YouTube URL");
  });

  it("timestamps: captures trailing instructions", () => {
    const s = startFeature("timestamps").session!;
    const a = handleText(s, "https://youtu.be/abc Make 10 chapters");
    expect(a.startJob?.payload).toEqual({
      url: "https://youtu.be/abc",
      instructions: "Make 10 chapters",
    });
  });

  it("timestamps: works without trailing instructions", () => {
    const s = startFeature("timestamps").session!;
    const a = handleText(s, "https://youtu.be/abc");
    expect(a.startJob?.payload).toEqual({ url: "https://youtu.be/abc" });
  });

  it("timestamps: rejects non-YouTube URL", () => {
    const s = startFeature("timestamps").session!;
    const a = handleText(s, "https://example.com/video");
    expect(a.startJob).toBeUndefined();
    expect(a.replies[0]!.text).toContain("valid YouTube URL");
  });
});

describe("no active step", () => {
  it("prompts to choose a feature", () => {
    const a = handleText({}, "hello");
    expect(a.replies[0]!.keyboard).toBe("main");
    expect(a.startJob).toBeUndefined();
  });
});
