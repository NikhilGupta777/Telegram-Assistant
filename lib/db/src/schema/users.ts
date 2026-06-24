import { pgTable, bigint, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/** One row per Telegram user who has interacted with the bot. */
export const usersTable = pgTable("users", {
  // Telegram user id (fits in bigint).
  id: bigint("id", { mode: "number" }).primaryKey(),
  username: text("username"),
  firstName: text("first_name"),
  jobCount: integer("job_count").notNull().default(0),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertUserSchema = createInsertSchema(usersTable);
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
