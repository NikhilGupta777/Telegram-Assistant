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
      new GetCommand({ TableName: this.table, Key: { pk: `JOB#${jobId}` } }),
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

  // ── Per-user lock (conditional put) ──
  async tryLock(userId: number): Promise<boolean> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.table,
          Item: { pk: `LOCK#${userId}`, ttl: this.ttl(LOCK_TTL_MS) },
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );
      return true;
    } catch (err) {
      if ((err as { name?: string }).name === "ConditionalCheckFailedException") {
        return false;
      }
      throw err;
    }
  }

  /** Record the jobId in the lock item once the job has been started. */
  async setLockJob(userId: number, jobId: string): Promise<void> {
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { pk: `LOCK#${userId}` },
          UpdateExpression: "SET jobId = :j",
          ExpressionAttributeValues: { ":j": jobId },
        }),
      );
    } catch {
      // Non-fatal: the lock item may have expired. Delivery still works via JOB# record.
    }
  }

  /** Returns the jobId for the user's active lock, or null if not locked / no job started yet. */
  async getActiveJobId(userId: number): Promise<string | null> {
    const r = await this.doc.send(
      new GetCommand({ TableName: this.table, Key: { pk: `LOCK#${userId}` } }),
    );
    if (!r.Item) return null;
    return (r.Item["jobId"] as string | undefined) ?? null;
  }

  async unlock(userId: number): Promise<void> {
    await this.doc.send(
      new DeleteCommand({ TableName: this.table, Key: { pk: `LOCK#${userId}` } }),
    );
  }
}
