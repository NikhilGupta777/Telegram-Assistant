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

  // ── Per-user lock (sliding window rate limiter: max 10 jobs per 3 mins) ──
  async tryLock(userId: number): Promise<boolean> {
    const pk = `RATELIMIT#${userId}`;
    try {
      const r = await this.doc.send(
        new GetCommand({ TableName: this.table, Key: { pk } })
      );
      const item = r.Item as { timestamps?: number[] } | undefined;
      const now = Date.now();
      const threeMinsAgo = now - 3 * 60 * 1000;

      const activeTimestamps = (item?.timestamps ?? []).filter((t) => t > threeMinsAgo);
      if (activeTimestamps.length >= 10) {
        return false;
      }

      activeTimestamps.push(now);
      await this.doc.send(
        new PutCommand({
          TableName: this.table,
          Item: {
            pk,
            timestamps: activeTimestamps,
            ttl: Math.floor((activeTimestamps[0]! + 3 * 60 * 1000) / 1000),
          },
        })
      );
      return true;
    } catch (err) {
      console.error("Rate limit check failed, bailing open to allow request:", err);
      return true;
    }
  }

  /** Record the jobId in the lock item once the job has been started. */
  async setLockJob(userId: number, jobId: string): Promise<void> {
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { pk: `LOCK#${userId}` },
          UpdateExpression: "ADD jobIds :j SET ttl = :t",
          ExpressionAttributeValues: {
            ":j": new Set([jobId]),
            ":t": Math.floor((Date.now() + 15 * 60 * 1000) / 1000),
          },
        }),
      );
    } catch (err) {
      console.error("Failed to set lock job:", err);
    }
  }

  /** Returns the jobId(s) for the user's active lock (comma-separated string), or null if not locked. */
  async getActiveJobId(userId: number): Promise<string | null> {
    const r = await this.doc.send(
      new GetCommand({ TableName: this.table, Key: { pk: `LOCK#${userId}` }, ConsistentRead: true }),
    );
    if (!r.Item) return null;
    const jobIds = r.Item["jobIds"];
    if (jobIds instanceof Set) {
      const arr = Array.from(jobIds) as string[];
      return arr.length ? arr.join(",") : null;
    }
    return (r.Item["jobId"] as string | undefined) ?? null;
  }

  async unlock(userId: number, jobId?: string): Promise<void> {
    if (jobId) {
      try {
        const r = await this.doc.send(
          new UpdateCommand({
            TableName: this.table,
            Key: { pk: `LOCK#${userId}` },
            UpdateExpression: "DELETE jobIds :j",
            ExpressionAttributeValues: { ":j": new Set([jobId]) },
            ReturnValues: "ALL_NEW",
          })
        );
        const updated = r.Attributes as { jobIds?: Set<string> } | undefined;
        if (!updated?.jobIds || updated.jobIds.size === 0) {
          await this.doc.send(
            new DeleteCommand({ TableName: this.table, Key: { pk: `LOCK#${userId}` } })
          );
        }
        return;
      } catch {
        // Fall back to full delete if set operation fails
      }
    }
    await this.doc.send(
      new DeleteCommand({ TableName: this.table, Key: { pk: `LOCK#${userId}` } }),
    );
  }

  /**
   * Atomic exactly-once delivery claim. The webhook (Lambda B) and the
   * poller (Lambda A self-invoke) both race to deliver the same job. The
   * first to set `delivered=true` wins and sends to Telegram; the loser
   * sees a ConditionalCheckFailedException and skips delivery.
   */
  async markDelivered(jobId: string): Promise<boolean> {
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { pk: `JOB#${jobId}` },
          UpdateExpression: "SET delivered = :t",
          ConditionExpression: "attribute_not_exists(delivered)",
          ExpressionAttributeValues: { ":t": true },
        }),
      );
      return true;
    } catch (err) {
      if ((err as { name?: string }).name === "ConditionalCheckFailedException") {
        return false;
      }
      // For unrelated DDB errors (network, throttling) we BAIL by returning
      // false. Better to skip a delivery than to send duplicates. The retry
      // path on the other side will catch it.
      return false;
    }
  }
}
