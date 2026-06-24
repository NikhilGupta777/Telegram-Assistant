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
    return {
      telegram: new Telegram(cfg.telegramBotToken),
      store: new DynamoStore(tableName),
      webhookSecret: cfg.vmsWebhookSecret,
    };
  })();
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

  const job: JobEnvelope = {
    jobId: payload.jobId,
    status: payload.status,
    ...(payload.succeeded !== undefined ? { succeeded: payload.succeeded } : {}),
    ...(payload.failed !== undefined ? { failed: payload.failed } : {}),
    ...(payload.result ? { result: payload.result } : {}),
    ...(payload.message ? { message: payload.message } : {}),
    terminal: true,
  };

  try {
    await deliverResult(telegram, mapping.chatId, mapping.feature, job, {
      ...(mapping.statusMessageId !== undefined
        ? { statusMessageId: mapping.statusMessageId }
        : {}),
    });
  } catch (err) {
    console.error("Failed to deliver result", err);
    // Fall through to cleanup; VMS retry would just re-deliver.
  } finally {
    await recordJobFinish({
      id: payload.jobId,
      status: payload.status,
      resultUrl: (payload.result?.["url"] ??
        payload.result?.["downloadUrl"] ??
        payload.result?.["fileUrl"]) as string | undefined,
      ...(payload.message ? { errorMessage: payload.message } : {}),
    }).catch(() => {});
    await store.delete(payload.jobId);
    await store.unlock(mapping.userId);
  }

  return { statusCode: 200, body: "ok" };
}
