import type { Telegram } from "telegraf";
import type { Feature } from "./format.js";
import type { JobStore } from "./store.js";
import { deliverResult } from "./deliver.js";
import { pollJob, isTerminal } from "./vms.js";

/**
 * Payload passed to the self-invoked poller Lambda. Lambda A submits a job
 * to VMS and immediately fires a second async invocation of itself with
 * this event so the poller is decoupled from the response Lambda's
 * lifecycle (same pattern the API repo uses for clip-cut workers).
 */
export interface BotPollerEvent {
  source: "bot.poll";
  jobId: string;
  chatId: number;
  userId: number;
  feature: Feature;
  statusMessageId?: number;
}

/**
 * Polls VMS for `jobId` until it reaches a terminal state, then delivers
 * to Telegram — but only if it wins the markDelivered race against the
 * webhook Lambda. Cheap when the webhook arrives first: the very next
 * poll sees the deletion and bails. Safe to abort early on errors.
 *
 * Designed to run inside a Lambda async invocation (InvocationType=Event)
 * — caller's Lambda timeout must be ≥ stopAfterMs + a few seconds.
 */
export async function runJobPoller(
  deps: {
    telegram: Telegram;
    jobs: JobStore;
    /** Bot DDB cleanup helper — same one the webhook calls in its finally block. */
    onDelivered?: (jobId: string, userId: number) => Promise<void>;
  },
  event: BotPollerEvent,
  opts: { intervalMs?: number; stopAfterMs?: number } = {},
): Promise<void> {
  const intervalMs = opts.intervalMs ?? 3000;
  const stopAfterMs = opts.stopAfterMs ?? 5 * 60 * 1000;
  const deadline = Date.now() + stopAfterMs;

  while (Date.now() < deadline) {
    let job;
    try {
      job = await pollJob(event.jobId);
    } catch {
      // Transient VMS error — keep trying until deadline or webhook wins.
      await sleep(intervalMs);
      continue;
    }

    if (isTerminal(job)) {
      // Did Lambda B (webhook) already deliver? If so, bail without re-sending.
      const won = await deps.jobs.markDelivered(event.jobId);
      if (!won) return;

      job.terminal = true;
      const deliverOpts =
        event.statusMessageId !== undefined
          ? { statusMessageId: event.statusMessageId }
          : {};
      try {
        await deliverResult(deps.telegram, event.chatId, event.feature, job, deliverOpts);
      } finally {
        if (deps.onDelivered) {
          await deps.onDelivered(event.jobId, event.userId).catch(() => {});
        }
        await deps.jobs.delete(event.jobId).catch(() => {});
        await deps.jobs.unlock(event.userId).catch(() => {});
      }
      return;
    }

    // Mid-flight; check if the webhook delivered while we were polling.
    // If the JOB# row is gone, the webhook handler already finished — bail.
    const stillRegistered = await deps.jobs.getJob(event.jobId);
    if (!stillRegistered) return;

    await sleep(intervalMs);
  }
  // Timed out — leave the mapping alone; the webhook may still arrive.
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
