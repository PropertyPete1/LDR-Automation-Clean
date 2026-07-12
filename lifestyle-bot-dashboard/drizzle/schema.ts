import {
  boolean,
  int,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core";

/**
 * Core user table backing auth flow.
 */
export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// ─── Bot Run Logs ─────────────────────────────────────────────────────────────
// One row per bot run. Used by the Agent Bot Activity dashboard panel.

export const botRunLogs = mysqlTable("bot_run_logs", {
  id: int("id").autoincrement().primaryKey(),
  botName: varchar("botName", { length: 128 }).notNull(),
  botSlug: varchar("botSlug", { length: 64 }).notNull(),
  sent: int("sent").notNull().default(0),
  errored: int("errored").notNull().default(0),
  skipped: int("skipped").notNull().default(0),
  status: mysqlEnum("status", ["ok", "warning", "error"]).notNull().default("ok"),
  ranAt: timestamp("ranAt").defaultNow().notNull(),
});

export type BotRunLog = typeof botRunLogs.$inferSelect;
export type InsertBotRunLog = typeof botRunLogs.$inferInsert;

// ─── Bot Observations ─────────────────────────────────────────────────────────
// Written by every bot at run_start, per-lead error, run_complete, and crash.
// Read by botMonitor for nightly health checks.

export const botObservations = mysqlTable("bot_observations", {
  id: int("id").autoincrement().primaryKey(),
  source: varchar("source", { length: 64 }).notNull(),
  category: mysqlEnum("category", [
    "run_start",
    "run_complete",
    "lead_error",
    "bot_crash",
    "fixed",
  ]).notNull(),
  severity: mysqlEnum("severity", ["info", "warning", "error"]).notNull(),
  message: text("message").notNull(),
  resolved: boolean("resolved").notNull().default(false),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type BotObservation = typeof botObservations.$inferSelect;
export type InsertBotObservation = typeof botObservations.$inferInsert;

// ─── SMS Sent Today ───────────────────────────────────────────────────────────
// Shared dedup table across all bots and pond nurture.
// Prevents double-texting a lead on the same calendar day.

export const smsSentToday = mysqlTable("sms_sent_today", {
  id: int("id").autoincrement().primaryKey(),
  personId: int("personId").notNull().unique(),
  agentName: varchar("agentName", { length: 128 }).notNull(),
  sentAt: timestamp("sentAt").defaultNow().notNull(),
});

export type SmsSentToday = typeof smsSentToday.$inferSelect;
export type InsertSmsSentToday = typeof smsSentToday.$inferInsert;

// ─── Contacted Leads ─────────────────────────────────────────────────────────
// One row per lead contacted by any agent bot.
// Powers the per-agent lead list view on the Agent Bots dashboard.

export const contactedLeads = mysqlTable("contacted_leads", {
  id: int("id").autoincrement().primaryKey(),
  botSlug: varchar("botSlug", { length: 64 }).notNull(),
  botName: varchar("botName", { length: 128 }).notNull(),
  personId: int("personId").notNull(),
  leadFirstName: varchar("leadFirstName", { length: 128 }),
  leadLastName: varchar("leadLastName", { length: 128 }),
  leadEmail: varchar("leadEmail", { length: 320 }),
  stage: varchar("stage", { length: 128 }),
  daysStale: int("daysStale").notNull().default(0),
  messageBody: text("messageBody"),
  sentAt: timestamp("sentAt").defaultNow().notNull(),
});

export type ContactedLead = typeof contactedLeads.$inferSelect;
export type InsertContactedLead = typeof contactedLeads.$inferInsert;
