import {
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import type { SessionState } from "./flow.js";
import type { SessionStore, JobStore, JobMapping } from "./store.js";

const SESSION_TTL_MS = 30 * 60 * 1000;
const LOCK_TTL_MS = 15 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function client(): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
}

/**
 * Single-table design. Partition key `pk`:
 *   SESSION#<userId>   → session state
 *   JOB#<jobId>        → job mapping (who to notify)
 *   LOCK#<userId>      → per-user in-flight lock (carries jobId once started)
 * All rows carry a numeric `ttl` (epoch seconds) for auto-expiry.
 */
export class DynamoStore implements SessionStore, JobStore {
  private readonly doc = client();
  constructor(private readonly table: string) {}

  private ttl(ms: number): number {
    return Math.floor((Date.now() + ms) / 1000);
  }

  // ── Sessions ──
  async get(userId: number): Promise<SessionState> {
    const r = await this.doc.send(
      new GetCommand({ TableName: this.table, Key: { pk: `SESSION#${userId}` } }),
    );
    const item = r.Item as { state?: SessionState } | undefined;
    if (!item?.state || (item.state.expiresAt && Date.now() > item.state.expiresAt)) {
      return { expiresAt: Date.now() + SESSION_TTL_MS };
    }
    return item.state;
  }

  async set(userId: number, patch: Partial<SessionState>): Promise<void> {
    const current = await this.get(userId);
    const state: SessionState = {
      ...current,
      ...patch,
      expiresAt: Date.now() + SESSION_TTL_MS,
    };
    await this.doc.send(
      new PutCommand({
        TableName: this.table,
        Item: { pk: `SESSION#${userId}`, state, ttl: this.ttl(SESSION_TTL_MS) },
      }),
    );
  }

  async clear(userId: number): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.table,
        Item: {
          pk: `SESSION#${userId}`,
          state: { expiresAt: Date.now() + SESSION_TTL_MS },
          ttl: this.ttl(SESSION_TTL_MS),
        },
      }),
    );
  }

  // ── Job mappings ──
  async put(mapping: JobMapping): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.table,
        Item: { pk: `JOB#${mapping.jobId}`, ...mapping, ttl: this.ttl(60 * 60 * 1000) },
      }),
    );
  }

  async getJob(jobId: string): Promise<JobMapping | null> {
    const r = await this.doc.send(
      new GetCommand({
        TableName: this.table,
        Key: { pk: `JOB#${jobId}` },
        ConsistentRead: true,
      }),
    );
    if (!r.Item) return null;
    const { pk: _pk, ttl: _ttl, ...mapping } = r.Item as Record<string, unknown>;
    return mapping as unknown as JobMapping;
  }

  async delete(jobId: string): Promise<void> {
    await this.doc.send(
      new DeleteCommand({ TableName: this.table, Key: { pk: `JOB#${jobId}` } }),
    );
  }

  // ── Per-user rate limit (atomic fixed-window counter: max 15 jobs / 3 min) ──
  // Uses a per-window row keyed by RATELIMIT#<userId>#<windowStart> and an
  // atomic ADD so concurrent requests can't race past the limit (the previous
  // read-modify-write on a shared row could be bypassed under burst). A fixed
  // window can allow up to ~2× the limit across a boundary — an acceptable
  // tradeoff for correctness and simplicity over a racy sliding window.
  async tryLock(userId: number): Promise<boolean> {
    const windowMs = 3 * 60 * 1000;
    const max = 15;
    const now = Date.now();
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const pk = `RATELIMIT#${userId}#${windowStart}`;
    try {
      const r = await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { pk },
          UpdateExpression: "ADD #c :one SET #ttl = :ttl",
          ExpressionAttributeNames: { "#c": "count", "#ttl": "ttl" },
          ExpressionAttributeValues: {
            ":one": 1,
            // Keep the row a full extra window so late-arriving increments in
            // the same window always land on a live row.
            ":ttl": Math.floor((windowStart + 2 * windowMs) / 1000),
          },
          ReturnValues: "UPDATED_NEW",
        })
      );
      const count = Number(r.Attributes?.["count"] ?? 1);
      return count <= max;
    } catch (err) {
      console.error("Rate limit check failed, bailing open to allow request:", err);
      return true;
    }
  }

  async setLockJob(userId: number, jobId: string): Promise<void> {
    if (!jobId) return;
    try {
      const pk = `LOCK#${userId}`;
      try {
        await this.doc.send(
          new UpdateCommand({
            TableName: this.table,
            Key: { pk },
            UpdateExpression: "ADD jobIds :jobId SET #ttl = :ttl",
            ExpressionAttributeNames: { "#ttl": "ttl" },
            ExpressionAttributeValues: {
              ":jobId": new Set([jobId]),
              ":ttl": Math.floor((Date.now() + 15 * 60 * 1000) / 1000),
            },
          })
        );
      } catch (err: any) {
        if (err.name === "ValidationException") {
          // Fallback if existing data is a List
          const r = await this.doc.send(new GetCommand({ TableName: this.table, Key: { pk }, ConsistentRead: true }));
          let arr: string[] = [];
          if (r.Item?.["jobIds"] && Array.isArray(r.Item["jobIds"])) arr = [...r.Item["jobIds"]];
          else if (r.Item?.["jobId"]) arr = [r.Item["jobId"]];
          
          if (!arr.includes(jobId)) arr.push(jobId);
          await this.doc.send(
            new PutCommand({
              TableName: this.table,
              Item: { pk, jobIds: new Set(arr), ttl: Math.floor((Date.now() + 15 * 60 * 1000) / 1000) },
            })
          );
        } else {
          throw err;
        }
      }
    } catch (err) {
      console.error("Failed to set lock job:", err);
    }
  }

  /** Returns the jobId(s) for the user's active lock (comma-separated string), or null if not locked. */
  async getActiveJobId(userId: number): Promise<string | null> {
    try {
      const r = await this.doc.send(
        new GetCommand({ TableName: this.table, Key: { pk: `LOCK#${userId}` }, ConsistentRead: true }),
      );
      if (!r.Item) return null;

      const jobIds = r.Item["jobIds"];
      if (Array.isArray(jobIds)) {
        const arr = jobIds.filter((id): id is string => typeof id === "string" && id.length > 0);
        return arr.length ? arr.join(",") : null;
      }

      if (jobIds instanceof Set) {
        const arr = Array.from(jobIds) as string[];
        return arr.length ? arr.join(",") : null;
      }

      return (r.Item["jobId"] as string | undefined) ?? null;
    } catch (err) {
      console.error("Failed to get active job ID:", err);
      return null;
    }
  }

  async unlock(userId: number, jobId?: string): Promise<void> {
    try {
      const pk = `LOCK#${userId}`;
      if (jobId) {
        try {
          await this.doc.send(
            new UpdateCommand({
              TableName: this.table,
              Key: { pk },
              UpdateExpression: "DELETE jobIds :jobId",
              ExpressionAttributeValues: {
                ":jobId": new Set([jobId]),
              },
            })
          );
          return;
        } catch (err: any) {
          if (err.name === "ValidationException") {
            // Fallback if existing data is a List
            const r = await this.doc.send(new GetCommand({ TableName: this.table, Key: { pk }, ConsistentRead: true }));
            let arr: string[] = [];
            if (r.Item?.["jobIds"] && Array.isArray(r.Item["jobIds"])) arr = [...r.Item["jobIds"]];
            else if (r.Item?.["jobId"]) arr = [r.Item["jobId"]];
            
            const filtered = arr.filter((id) => id !== jobId);
            if (filtered.length > 0) {
              await this.doc.send(
                new PutCommand({
                  TableName: this.table,
                  Item: { pk, jobIds: new Set(filtered), ttl: Math.floor((Date.now() + 15 * 60 * 1000) / 1000) },
                })
              );
              return;
            }
          } else {
            throw err;
          }
        }
      }

      await this.doc.send(
        new DeleteCommand({ TableName: this.table, Key: { pk } }),
      );
    } catch (err) {
      console.error("Failed to unlock user:", err);
      // Fallback to full delete to be safe
      try {
        await this.doc.send(
          new DeleteCommand({ TableName: this.table, Key: { pk: `LOCK#${userId}` } }),
        );
      } catch {}
    }
  }

  /**
   * Atomic exactly-once delivery claim. The webhook (Lambda B) and the
   * poller (Lambda A self-invoke) both race to deliver the same job. The
   * first to set `delivered=true` wins and sends to Telegram; the loser
   * sees a ConditionalCheckFailedException and skips delivery.
   */
  async markDelivered(jobId: string): Promise<boolean> {
    // `attribute_exists(pk)` is CRITICAL: UpdateItem is an upsert, so a bare
    // `attribute_not_exists(delivered)` condition would SUCCEED on a row that
    // the winner already deleted — recreating a ghost row and returning "won",
    // which re-delivers the result (the exact duplicate this guards against).
    // Requiring the row to still exist makes the loser correctly see false.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.doc.send(
          new UpdateCommand({
            TableName: this.table,
            Key: { pk: `JOB#${jobId}` },
            UpdateExpression: "SET delivered = :t",
            ConditionExpression:
              "attribute_exists(pk) AND attribute_not_exists(delivered)",
            ExpressionAttributeValues: { ":t": true },
          }),
        );
        return true;
      } catch (err) {
        const name = (err as { name?: string }).name;
        if (name === "ConditionalCheckFailedException") {
          // Either someone already delivered, or the row was cleaned up — in
          // both cases we must NOT deliver.
          return false;
        }
        // Transient DDB error (network, throttle). Retry a couple of times
        // before giving up so a blip doesn't drop the only delivery. Bailing
        // to false on the last attempt preserves "skip rather than duplicate".
        if (attempt === 2) return false;
        await sleep(100 * (attempt + 1));
      }
    }
    return false;
  }
}
