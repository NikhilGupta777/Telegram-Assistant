import { desc, eq, sql } from "drizzle-orm";
import { usersTable, jobsTable, type Job } from "./schema/index.js";

/**
 * Optional database access. The bot must work with or without a provisioned DB:
 * if DATABASE_URL is unset, every call becomes a no-op and reads return empty.
 * This keeps the local runner and Lambda functioning even before a DB exists.
 */

let dbPromise: Promise<typeof import("./index.js")["db"] | null> | undefined;

async function getDb() {
  if (dbPromise) return dbPromise;
  dbPromise = (async () => {
    if (!process.env["DATABASE_URL"]) return null;
    const mod = await import("./index.js");
    return mod.db;
  })();
  return dbPromise;
}

export async function upsertUser(input: {
  id: number;
  username?: string | undefined;
  firstName?: string | undefined;
}): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db
    .insert(usersTable)
    .values({
      id: input.id,
      username: input.username ?? null,
      firstName: input.firstName ?? null,
    })
    .onConflictDoUpdate({
      target: usersTable.id,
      set: {
        username: input.username ?? null,
        firstName: input.firstName ?? null,
        lastSeenAt: sql`now()`,
      },
    });
}

export async function recordJobStart(input: {
  id: string;
  userId: number;
  chatId: number;
  feature: string;
}): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db
    .insert(jobsTable)
    .values({
      id: input.id,
      userId: input.userId,
      chatId: input.chatId,
      feature: input.feature,
      status: "running",
    })
    .onConflictDoNothing();
  await db
    .update(usersTable)
    .set({ jobCount: sql`${usersTable.jobCount} + 1` })
    .where(eq(usersTable.id, input.userId));
}

export async function recordJobFinish(input: {
  id: string;
  status: string;
  resultUrl?: string | undefined;
  errorMessage?: string | undefined;
}): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db
    .update(jobsTable)
    .set({
      status: input.status,
      resultUrl: input.resultUrl ?? null,
      errorMessage: input.errorMessage ?? null,
      finishedAt: sql`now()`,
    })
    .where(eq(jobsTable.id, input.id));
}

export async function recentJobs(userId: number, limit = 10): Promise<Job[]> {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.userId, userId))
    .orderBy(desc(jobsTable.createdAt))
    .limit(limit);
}
