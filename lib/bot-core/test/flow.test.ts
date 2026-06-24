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

describe("clip cut 3-step form", () => {
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

  it("rejects an invalid url at step 1", () => {
    const s = startFeature("cut").session!;
    const a = handleText(s, "nope");
    expect(a.startJob).toBeUndefined();
    expect(a.replies[0]!.text).toContain("valid YouTube URL");
    expect(a.session?.step).toBe("cut_url"); // unchanged
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

  it("rejects an unparseable time", () => {
    let s = startFeature("cut").session!;
    s = handleText(s, "https://youtu.be/abc").session!;
    const a = handleText(s, "abc");
    expect(a.session?.step).toBe("cut_start");
    expect(a.replies[0]!.text).toContain("Invalid time");
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

  it("subtitles: starts with language auto", () => {
    const s = startFeature("subtitles").session!;
    const a = handleText(s, "https://youtu.be/abc");
    expect(a.startJob?.payload).toEqual({
      url: "https://youtu.be/abc",
      language: "auto",
    });
  });

  it("timestamps: captures trailing instructions", () => {
    const s = startFeature("timestamps").session!;
    const a = handleText(s, "https://youtu.be/abc Make 10 chapters");
    expect(a.startJob?.payload).toEqual({
      url: "https://youtu.be/abc",
      instructions: "Make 10 chapters",
    });
  });
});

describe("no active step", () => {
  it("prompts to choose a feature", () => {
    const a = handleText({}, "hello");
    expect(a.replies[0]!.keyboard).toBe("main");
    expect(a.startJob).toBeUndefined();
  });
});
