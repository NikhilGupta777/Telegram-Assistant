import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { Telegram } from "telegraf";
import { loadConfigFromSsm } from "@workspace/bot-core/config";
import { DynamoStore } from "@workspace/bot-core/dynamo";
import { deliverResult } from "@workspace/bot-core/telegram";
import {
  verifySignature,
  pollJob,
  type JobEnvelope,
  type VmsWebhookPayload,
} from "@workspace/bot-core";
import { recordJobFinish } from "@workspace/db/repo";

interface Deps {
  telegram: Telegram;
  store: DynamoStore;
  webhookSecret: string;
}

let depsPromise: Promise<Deps> | undefined;

async function getDeps(): Promise<Deps> {
  if (depsPromise) return depsPromise;
  depsPromise = (async () => {
    const cfg = await loadConfigFromSsm();
    const tableName = cfg.tableName ?? process.env["TABLE_NAME"]!;
    if (!cfg.vmsWebhookSecret) {
      console.warn(
        "[vms-webhook] VMS_WEBHOOK_SECRET is empty — ALL webhooks will fail " +
          "signature verification and be rejected; delivery falls back to the poller only.",
      );
    }
    return {
      telegram: new Telegram(cfg.telegramBotToken),
      store: new DynamoStore(tableName),
      webhookSecret: cfg.vmsWebhookSecret,
    };
  })();
  // Don't cache a rejected init on the warm container.
  depsPromise.catch(() => {
    depsPromise = undefined;
  });
  return depsPromise;
}

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const { telegram, store, webhookSecret } = await getDeps();

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body ?? "", "base64").toString("utf-8")
    : event.body ?? "";

  // Verify HMAC signature to prevent spoofed completions.
  const signature =
    event.headers?.["x-vms-signature"] ?? event.headers?.["X-VMS-Signature"];
  if (!verifySignature(rawBody, signature, webhookSecret)) {
    console.warn("Rejected VMS webhook: bad signature");
    return { statusCode: 401, body: "unauthorized" };
  }

  let payload: VmsWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as VmsWebhookPayload;
  } catch {
    return { statusCode: 400, body: "bad request" };
  }

  const mapping = await store.getJob(payload.jobId);
  if (!mapping) {
    // Unknown or already-handled job — ack so VMS stops retrying.
    console.warn("No mapping for job", payload.jobId);
    return { statusCode: 200, body: "ok" };
  }

  // VMS sends the error code under any of these — normalise to one field.
  const errorCode = payload.errorCode ?? payload.error?.code ?? payload.code;
  const errorMessage = payload.message ?? payload.error?.message;

  // The webhook body itself is just a "ready" ping — VMS doesn't include
  // `result.url` in it. Fetch the full envelope via the public jobs API so
  // we get the signed download URL (and any other result metadata) before
  // delivering. On poll failure we fall back to the ping-derived envelope
  // so behaviour never regresses below what we had before.
  let job: JobEnvelope;
  try {
    const fetched = await pollJob(payload.jobId);
    job = {
      ...fetched,
      terminal: true,
      ...(payload.succeeded !== undefined ? { succeeded: payload.succeeded } : {}),
      ...(payload.failed !== undefined ? { failed: payload.failed } : {}),
      ...(errorMessage ? { message: errorMessage } : fetched.message ? { message: fetched.message } : {}),
      ...(errorCode ? { errorCode } : {}),
    };
  } catch (err) {
    console.warn("[vms-webhook] pollJob failed, using ping payload as fallback", err);
    job = {
      jobId: payload.jobId,
      status: payload.status,
      ...(payload.succeeded !== undefined ? { succeeded: payload.succeeded } : {}),
      ...(payload.failed !== undefined ? { failed: payload.failed } : {}),
      ...(payload.result ? { result: payload.result } : {}),
      ...(errorMessage ? { message: errorMessage } : {}),
      ...(errorCode ? { errorCode } : {}),
      terminal: true,
    };
  }

  // Race the poller (Lambda A self-invoke) to claim delivery. Whoever calls
  // markDelivered first wins; the loser exits without re-sending. This is
  // what kills duplicate "Your clip is ready!" messages.
  const won = await store.markDelivered(payload.jobId);
  if (!won) {
    console.info("[vms-webhook] poller already delivered", payload.jobId);
    return { statusCode: 200, body: "ok" };
  }

  try {
    await deliverResult(telegram, mapping.chatId, mapping.feature, job, {
      ...(mapping.statusMessageId !== undefined
        ? { statusMessageId: mapping.statusMessageId }
        : {}),
      ...(mapping.username ? { username: mapping.username } : {}),
      ...(mapping.payload ? { payload: mapping.payload } : {}),
    });
  } catch (err) {
    console.error("Failed to deliver result", err);
    // Fall through to cleanup; VMS retry would just re-deliver.
  } finally {
    await recordJobFinish({
      id: payload.jobId,
      status: payload.status,
      resultUrl: (job.result?.["url"] ??
        job.result?.["downloadUrl"] ??
        job.result?.["fileUrl"]) as string | undefined,
      ...(payload.message ? { errorMessage: payload.message } : {}),
    }).catch(() => {});
    await store.delete(payload.jobId);
    await store.unlock(mapping.userId, payload.jobId);
  }

  return { statusCode: 200, body: "ok" };
}
