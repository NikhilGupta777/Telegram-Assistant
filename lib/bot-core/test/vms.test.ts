import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import {
  verifySignature,
  isTerminal,
  isSucceeded,
  startJob,
  VmsError,
} from "../src/vms.js";

describe("verifySignature", () => {
  const secret = "shhh";
  const body = JSON.stringify({ jobId: "j1", status: "done" });
  const sig = createHmac("sha256", secret).update(body).digest("hex");

  it("accepts a valid signature", () => {
    expect(verifySignature(body, sig, secret)).toBe(true);
  });
  it("accepts the sha256= prefixed form", () => {
    expect(verifySignature(body, `sha256=${sig}`, secret)).toBe(true);
  });
  it("rejects a tampered body", () => {
    expect(verifySignature(body + "x", sig, secret)).toBe(false);
  });
  it("rejects a wrong secret", () => {
    expect(verifySignature(body, sig, "wrong")).toBe(false);
  });
  it("rejects missing inputs", () => {
    expect(verifySignature(body, undefined, secret)).toBe(false);
    expect(verifySignature(body, sig, undefined)).toBe(false);
    expect(verifySignature(body, "nothex", secret)).toBe(false);
  });
});

describe("isTerminal / isSucceeded", () => {
  it("detects terminal statuses", () => {
    expect(isTerminal({ jobId: "j", status: "running" })).toBe(false);
    expect(isTerminal({ jobId: "j", status: "done" })).toBe(true);
    expect(isTerminal({ jobId: "j", status: "error" })).toBe(true);
    expect(isTerminal({ jobId: "j", status: "x", terminal: true })).toBe(true);
  });
  it("detects success", () => {
    expect(isSucceeded({ jobId: "j", status: "done" })).toBe(true);
    expect(isSucceeded({ jobId: "j", status: "done", failed: true })).toBe(false);
    expect(isSucceeded({ jobId: "j", status: "error" })).toBe(false);
  });
});

describe("startJob", () => {
  beforeEach(() => {
    process.env["VMS_API_KEY"] = "test-key";
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts payload + webhookUrl + idempotency key and returns the envelope", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ jobId: "abc", status: "pending" }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const job = await startJob(
      "clips",
      { url: "https://y" },
      { webhookUrl: "https://hook", idempotencyKey: "k1" },
    );
    expect(job.jobId).toBe("abc");

    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/api/v1/clips");
    const headers = (opts as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-key");
    expect(headers["Idempotency-Key"]).toBe("k1");
    const sent = JSON.parse((opts as RequestInit).body as string);
    expect(sent.webhookUrl).toBe("https://hook");
    expect(sent.url).toBe("https://y");
  });

  it("throws a VmsError with parsed code on error response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ error: { code: "INVALID_REQUEST", message: "bad url" } }),
          { status: 400 },
        ),
      ),
    );
    await expect(startJob("clips", {})).rejects.toMatchObject({
      name: "VmsError",
      httpStatus: 400,
      code: "INVALID_REQUEST",
    });
  });

  it("throws if VMS_API_KEY is missing", async () => {
    delete process.env["VMS_API_KEY"];
    vi.stubGlobal("fetch", vi.fn());
    await expect(startJob("clips", {})).rejects.toThrow(/VMS_API_KEY/);
  });
});
