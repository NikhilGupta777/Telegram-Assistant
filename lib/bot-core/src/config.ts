import { SSMClient, GetParametersCommand } from "@aws-sdk/client-ssm";

/**
 * Resolved bot configuration. Secrets come from SSM Parameter Store in Lambda,
 * or from process.env for the local runner.
 */
export interface BotConfig {
  telegramBotToken: string;
  telegramWebhookSecret: string;
  vmsApiKey: string;
  vmsWebhookSecret: string;
  /** Public base URL VMS should call back, e.g. https://abc.lambda-url.../ */
  vmsWebhookBaseUrl?: string;
  tableName?: string;
  databaseUrl?: string;
  allowedUsers?: number[];
}

let cached: BotConfig | undefined;

/** Read directly from environment (local runner / tests). */
export function configFromEnv(): BotConfig {
  const get = (k: string) => process.env[k];
  const require = (k: string): string => {
    const v = get(k);
    if (!v) throw new Error(`${k} not set`);
    return v;
  };
  return {
    telegramBotToken: require("TELEGRAM_BOT_TOKEN"),
    telegramWebhookSecret: get("TELEGRAM_WEBHOOK_SECRET") ?? "",
    vmsApiKey: require("VMS_API_KEY"),
    vmsWebhookSecret: get("VMS_WEBHOOK_SECRET") ?? "",
    ...(get("VMS_WEBHOOK_BASE_URL") ? { vmsWebhookBaseUrl: get("VMS_WEBHOOK_BASE_URL")! } : {}),
    ...(get("TABLE_NAME") ? { tableName: get("TABLE_NAME")! } : {}),
    ...(get("DATABASE_URL") ? { databaseUrl: get("DATABASE_URL")! } : {}),
    ...(get("ALLOWED_USERS") ? { allowedUsers: get("ALLOWED_USERS")!.split(',').map(s => Number(s.trim())).filter(n => !isNaN(n)) } : {}),
  };
}

/**
 * Load config in a Lambda: SSM parameter names come from env vars
 * (so the same code works across stacks). Cached on the warm container.
 * Also mirrors the secrets into process.env so downstream modules
 * (vms.ts reads VMS_API_KEY) work unchanged.
 */
export async function loadConfigFromSsm(): Promise<BotConfig> {
  if (cached) return cached;

  const names = {
    telegramBotToken: process.env["SSM_TELEGRAM_BOT_TOKEN"],
    telegramWebhookSecret: process.env["SSM_TELEGRAM_WEBHOOK_SECRET"],
    vmsApiKey: process.env["SSM_VMS_API_KEY"],
    vmsWebhookSecret: process.env["SSM_VMS_WEBHOOK_SECRET"],
    allowedUsers: process.env["SSM_ALLOWED_USERS"],
  };

  const wanted = Object.values(names).filter((n): n is string => !!n);
  const resolved: Record<string, string> = {};

  if (wanted.length) {
    const ssm = new SSMClient({});
    // GetParameters accepts up to 10 names per call — fine for our 4.
    const out = await ssm.send(
      new GetParametersCommand({ Names: wanted, WithDecryption: true }),
    );
    for (const p of out.Parameters ?? []) {
      if (p.Name && p.Value) resolved[p.Name] = p.Value;
    }
  }

  const pick = (paramName: string | undefined, envFallback: string): string =>
    (paramName ? resolved[paramName] : undefined) ?? process.env[envFallback] ?? "";

  cached = {
    telegramBotToken: pick(names.telegramBotToken, "TELEGRAM_BOT_TOKEN"),
    telegramWebhookSecret: pick(names.telegramWebhookSecret, "TELEGRAM_WEBHOOK_SECRET"),
    vmsApiKey: pick(names.vmsApiKey, "VMS_API_KEY"),
    vmsWebhookSecret: pick(names.vmsWebhookSecret, "VMS_WEBHOOK_SECRET"),
    ...(process.env["VMS_WEBHOOK_BASE_URL"]
      ? { vmsWebhookBaseUrl: process.env["VMS_WEBHOOK_BASE_URL"] }
      : {}),
    ...(process.env["TABLE_NAME"] ? { tableName: process.env["TABLE_NAME"] } : {}),
    ...(process.env["DATABASE_URL"] ? { databaseUrl: process.env["DATABASE_URL"] } : {}),
  };
  
  const allowedUsersStr = pick(names.allowedUsers, "ALLOWED_USERS");
  if (allowedUsersStr) {
    cached.allowedUsers = allowedUsersStr.split(',').map(s => Number(s.trim())).filter(n => !isNaN(n));
  }

  // Mirror into env so vms.ts (which reads process.env) works unchanged.
  process.env["VMS_API_KEY"] = cached.vmsApiKey;

  return cached;
}
