import {
  pgTable,
  text,
  bigint,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/** One row per VMS job started through the bot. Powers /history + analytics. */
export const jobsTable = pgTable(
  "jobs",
  {
    // VMS jobId.
    id: text("id").primaryKey(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    chatId: bigint("chat_id", { mode: "number" }).notNull(),
    feature: text("feature").notNull(), // clips | cut | subtitles | timestamps | download
    status: text("status").notNull().default("pending"),
    resultUrl: text("result_url"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("jobs_user_id_created_at_idx").on(t.userId, t.createdAt)],
);

export const insertJobSchema = createInsertSchema(jobsTable);
export type InsertJob = z.infer<typeof insertJobSchema>;
export type Job = typeof jobsTable.$inferSelect;
