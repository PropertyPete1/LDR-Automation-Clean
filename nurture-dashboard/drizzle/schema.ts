import { boolean, int, mysqlEnum, mysqlTable, text, timestamp, varchar } from "drizzle-orm/mysql-core";

/**
 * Core user table backing auth flow.
 * Extend this file with additional tables as your product grows.
 * Columns use camelCase to match both database fields and generated types.
 */
export const users = mysqlTable("users", {
  /**
   * Surrogate primary key. Auto-incremented numeric value managed by the database.
   * Use this for relations between tables.
   */
  id: int("id").autoincrement().primaryKey(),
  /** Manus OAuth identifier (openId) returned from the OAuth callback. Unique per user. */
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

// TODO: Add your tables here

/**
 * Stores per-agent memories that persist across Copilot sessions.
 * The Copilot reads these and injects them into its system prompt so it
 * "remembers" agent preferences, lead patterns, and brokerage insights.
 */
export const copilotMemories = mysqlTable("copilot_memories", {
  id: int("id").autoincrement().primaryKey(),
  agentName: varchar("agent_name", { length: 100 }).notNull(),
  memoryText: text("memory_text").notNull(),
  category: varchar("category", { length: 50 }).default("general").notNull(), // e.g. 'agent_style', 'lead_insight', 'market_knowledge'
  importanceScore: int("importance_score").default(1).notNull(), // 1-5, higher = more important
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type CopilotMemory = typeof copilotMemories.$inferSelect;
export type InsertCopilotMemory = typeof copilotMemories.$inferInsert;

/**
 * Tracks which AI-drafted messages agents actually sent vs ignored.
 * Positive signals (sent) teach the Copilot what works; negative signals
 * (ignored/regenerated) teach it what to avoid.
 */
export const copilotFeedback = mysqlTable("copilot_feedback", {
  id: int("id").autoincrement().primaryKey(),
  agentName: varchar("agent_name", { length: 100 }).notNull(),
  draftText: text("draft_text").notNull(),
  leadCity: varchar("lead_city", { length: 100 }),
  leadStage: varchar("lead_stage", { length: 100 }),
  draftType: varchar("draft_type", { length: 20 }).default("outbound").notNull(), // 'outbound' | 'reply'
  action: mysqlEnum("action", ["sent", "ignored", "regenerated", "edited"]).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type CopilotFeedback = typeof copilotFeedback.$inferSelect;
export type InsertCopilotFeedback = typeof copilotFeedback.$inferInsert;

/**
 * Daytime error memory for the overnight self-healing system.
 * Every tRPC failure, FUB API error, or UI crash during the day is written here.
 * The nightly healer reads unresolved rows, applies targeted fixes, and marks them resolved.
 * Rows older than 30 days are pruned automatically by the weekly cleanup cron.
 */
export const uiErrorLog = mysqlTable("ui_error_log", {
  id: int("id").autoincrement().primaryKey(),
  /** Who triggered the error — 'owner' or agent slug like 'peter', 'steven', etc. */
  actor: varchar("actor", { length: 100 }).notNull().default("unknown"),
  /** The tRPC procedure or UI action that failed, e.g. 'agent.getRoster', 'audit.run' */
  action: varchar("action", { length: 200 }).notNull(),
  /** Short error message or code */
  errorMessage: text("error_message").notNull(),
  /** Full stack trace or additional context (optional) */
  errorDetail: text("error_detail"),
  /** Broad category for grouping in the healer: 'fub_api' | 'roster' | 'audit' | 'sms' | 'queue' | 'auth' | 'ui_crash' | 'other' */
  category: varchar("category", { length: 50 }).notNull().default("other"),
  /** Whether the nightly healer has already processed and fixed this error */
  resolved: mysqlEnum("resolved", ["no", "yes", "unfixable"]).notNull().default("no"),
  /** What fix the healer applied (filled in by nightly_health.py) */
  fixApplied: text("fix_applied"),
  /** When the error occurred */
  createdAt: timestamp("created_at").defaultNow().notNull(),
  /** When the healer resolved it */
  resolvedAt: timestamp("resolved_at"),
});

export type UiErrorLog = typeof uiErrorLog.$inferSelect;
export type InsertUiErrorLog = typeof uiErrorLog.$inferInsert;

/**
 * Tracks which leads were texted via the Power Queue today.
 * Persists across server restarts so the queue never shows already-texted leads.
 * Rows are automatically filtered by date (CT) so old rows are harmless.
 * Pruned weekly by the cleanup cron.
 */
export const smsSentToday = mysqlTable("sms_sent_today", {
  id: int("id").autoincrement().primaryKey(),
  /** FUB person ID of the lead that was texted */
  personId: int("person_id").notNull(),
  /** Agent name who sent the text */
  agentName: varchar("agent_name", { length: 100 }).notNull().default("unknown"),
  /** Calendar date in CT (YYYY-MM-DD) — used to filter today's sends */
  sentDate: varchar("sent_date", { length: 10 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type SmsSentToday = typeof smsSentToday.$inferSelect;
export type InsertSmsSentToday = typeof smsSentToday.$inferInsert;
export const botRunLog = mysqlTable("bot_run_log", {
  id: int("id").autoincrement().primaryKey(),
  runAt: timestamp("run_at").defaultNow().notNull(),
  leadsTexted: int("leads_texted").notNull().default(0),
  leadsFailed: int("leads_failed").notNull().default(0),
  leadsEvaluated: int("leads_evaluated").notNull().default(0),
  emailSent: mysqlEnum("email_sent", ["yes", "no", "skipped"]).notNull().default("no"),
  summary: text("summary"),
  triggeredBy: mysqlEnum("triggered_by", ["cron", "manual"]).notNull().default("cron"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
export type BotRunLog = typeof botRunLog.$inferSelect;
export type InsertBotRunLog = typeof botRunLog.$inferInsert;
/** Alias for backward compatibility with botHelpers.ts (plural form) */
export const botRunLogs = botRunLog;

/**
 * Autonomous monitoring engine run log.
 * Every 30-minute monitor run records what it checked, found, and fixed.
 * Surfaces in the dashboard "System Monitor" section so the team can see
 * the bot's health-check activity without opening logs.
 */
export const botMonitorLog = mysqlTable("bot_monitor_log", {
  id: int("id").autoincrement().primaryKey(),
  runAt: timestamp("run_at").defaultNow().notNull(),
  checksRun: int("checks_run").default(0).notNull(),
  issuesFound: int("issues_found").default(0).notNull(),
  issuesFixed: int("issues_fixed").default(0).notNull(),
  /** JSON array of {check, status, detail} — full findings list */
  findings: text("findings"),
  summary: text("summary"),
  triggeredBy: varchar("triggered_by", { length: 20 }).default("cron").notNull(),
  durationMs: int("duration_ms").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type BotMonitorLog = typeof botMonitorLog.$inferSelect;
export type InsertBotMonitorLog = typeof botMonitorLog.$inferInsert;

/**
 * Unified observation log written by every automated bot in the system.
 * Acts as the shared "nervous system" — all bots write here, both nightly
 * healers read here. This is how the system sees itself.
 *
 * Sources: bot_monitor | lifestyle_bot | speed_to_lead | pond_nurture |
 *          nightly_healer | ui_error (promoted from ui_error_log)
 *
 * Severity: info | warning | error | fixed
 *   - info    = routine activity (bot ran, X leads texted)
 *   - warning = something unusual but not broken
 *   - error   = something is broken and needs fixing
 *   - fixed   = was an error, healer auto-fixed it overnight
 */
export const botObservations = mysqlTable("bot_observations", {
  id: int("id").autoincrement().primaryKey(),
  /** Which system wrote this observation */
  source: varchar("source", { length: 50 }).notNull(), // 'bot_monitor' | 'lifestyle_bot' | 'speed_to_lead' | 'pond_nurture' | 'nightly_healer' | 'ui_error'
  /** Severity level */
  severity: mysqlEnum("severity", ["info", "warning", "error", "fixed"]).notNull(),
  /** Broad category for healer routing */
  category: varchar("category", { length: 80 }).notNull(), // e.g. 'fub_api', 'bot_health', 'lead_accuracy', 'smtp', 'speed_to_lead', 'pond_nurture'
  /** Short human-readable message (shown in UI feed) */
  message: varchar("message", { length: 255 }).notNull(),
  /** Full detail / context (JSON string or plain text) */
  detail: text("detail"),
  /** Whether the nightly healer can auto-fix this */
  autoFixable: int("auto_fixable").default(0).notNull(), // 0 = no, 1 = yes
  /** When the healer fixed this (null = not yet fixed) */
  fixedAt: timestamp("fixed_at"),
  /** What fix was applied */
  fixNote: text("fix_note"),
  /** Run ID so related observations from one bot run can be grouped */
  runId: varchar("run_id", { length: 64 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type BotObservation = typeof botObservations.$inferSelect;
export type InsertBotObservation = typeof botObservations.$inferInsert;

/**
 * Deduplication table for the automated reply intent detector.
 * Tracks every Gmail message ID that has already been processed so the handler
 * never re-classifies the same email twice across runs.
 *
 * Source: reply_intent_handler (runs every 2 hours via heartbeat cron)
 */
export const replyIntentProcessed = mysqlTable("reply_intent_processed", {
  id: int("id").autoincrement().primaryKey(),
  /** Gmail message UID (numeric) — unique per mailbox */
  gmailMessageId: varchar("gmail_message_id", { length: 64 }).notNull().unique(),
  /** Sender email address (lead's email) */
  senderEmail: varchar("sender_email", { length: 320 }).notNull(),
  /** FUB person ID if the lead was found in FUB (null if not found) */
  fubPersonId: int("fub_person_id"),
  /** What action was taken: 'opted_out' | 'no_intent' | 'not_in_fub' | 'already_opted_out' */
  action: varchar("action", { length: 50 }).notNull(),
  /** LLM confidence score 0.0-1.0 */
  confidence: varchar("confidence", { length: 10 }),
  /** Short reason from LLM classifier */
  reason: varchar("reason", { length: 500 }),
  processedAt: timestamp("processed_at").defaultNow().notNull(),
});

export type ReplyIntentProcessed = typeof replyIntentProcessed.$inferSelect;
export type InsertReplyIntentProcessed = typeof replyIntentProcessed.$inferInsert;

/**
 * Unified Compliance Layer — suppressed leads registry.
 * Every unsubscribe, bounce-trash, or opt-out action across ALL systems
 * writes here. Single source of truth for suppression state.
 * Systems check this before sending any email or text.
 *
 * Sources: compliance_layer | bounce_handler | reply_intent | power_queue | lifestyle_bot
 * Reasons: 'unsubscribe' | 'bounce_no_phone' | 'opt_out_reply' | 'agent_marked' | 'manual'
 */
export const suppressedLeads = mysqlTable("suppressed_leads", {
  id: int("id").autoincrement().primaryKey(),
  /** FUB person ID — the primary suppression key */
  personId: int("person_id").notNull(),
  /** Email address that was suppressed (for bounce tracking) */
  email: varchar("email", { length: 320 }),
  /** Why this lead was suppressed */
  reason: mysqlEnum("reason", [
    "unsubscribe",
    "bounce_no_phone",
    "opt_out_reply",
    "agent_marked",
    "manual",
  ]).notNull(),
  /** Which system triggered the suppression */
  source: varchar("source", { length: 80 }).notNull(),
  /** Lead name at time of suppression (for display) */
  leadName: varchar("lead_name", { length: 200 }),
  /** Agent who was assigned at time of suppression */
  agentName: varchar("agent_name", { length: 100 }),
  suppressedAt: timestamp("suppressed_at").defaultNow().notNull(),
});
export type SuppressedLead = typeof suppressedLeads.$inferSelect;
export type InsertSuppressedLead = typeof suppressedLeads.$inferInsert;

/**
 * Per-lead memory store for the AI Copilot.
 * Stores context about individual leads that persists across sessions —
 * what the lead cares about, what has been tried, what tone works, outcomes.
 * The Copilot reads this alongside agent memories when generating suggestions.
 *
 * Category: 'lead_preference' | 'contact_history' | 'objection' | 'intent_signal' | 'general'
 */
export const leadMemory = mysqlTable("lead_memory", {
  id: int("id").autoincrement().primaryKey(),
  /** FUB person ID this memory belongs to */
  personId: int("person_id").notNull(),
  /** Agent associated with this memory (for agent-specific context) */
  agentName: varchar("agent_name", { length: 100 }).notNull(),
  /** The memory text — concise, factual, actionable */
  memoryText: text("memory_text").notNull(),
  /** Category for retrieval filtering */
  category: varchar("category", { length: 50 }).default("general").notNull(),
  /** 1-5 importance score — higher = injected first into context window */
  importanceScore: int("importance_score").default(1).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
export type LeadMemory = typeof leadMemory.$inferSelect;
export type InsertLeadMemory = typeof leadMemory.$inferInsert;

/**
 * Pond Nurture cadence dedup log.
 * Tracks the last time each pond lead received an automated nurture email.
 * Used to enforce the 14-day cadence cap (replaces Python SQLite reengagement_log).
 *
 * Source: pond_nurture engine (runs daily at 8am CT via heartbeat cron)
 */
export const pondNurtureLog = mysqlTable("pond_nurture_log", {
  id: int("id").autoincrement().primaryKey(),
  /** FUB person ID — unique per lead */
  personId: int("person_id").notNull().unique(),
  /** City or area focus used in the last email */
  city: varchar("city", { length: 100 }).default("Texas/general").notNull(),
  /** Subject line of the last email sent */
  subject: varchar("subject", { length: 500 }).notNull(),
  /** When the last nurture email was sent */
  sentAt: timestamp("sent_at").defaultNow().notNull(),
});
export type PondNurtureLog = typeof pondNurtureLog.$inferSelect;
export type InsertPondNurtureLog = typeof pondNurtureLog.$inferInsert;

/**
 * Auto-pond promotion run log.
 * Tracks each nightly run that moves stale agent leads (created 20+ days ago) to the pond.
 * Used for dashboard display and audit trail.
 */
export const pondPromotionLog = mysqlTable("pond_promotion_log", {
  id: int("id").autoincrement().primaryKey(),
  /** When this promotion run executed */
  ranAt: timestamp("ran_at").defaultNow().notNull(),
  /** How many leads were moved to the pond */
  promoted: int("promoted").default(0).notNull(),
  /** How many leads were skipped (excluded stage/tag/already in pond) */
  skipped: int("skipped").default(0).notNull(),
  /** How many FUB API errors occurred */
  errors: int("errors").default(0).notNull(),
  /** "cron" or "manual" */
  triggeredBy: varchar("triggered_by", { length: 20 }).default("cron").notNull(),
  /** Duration in milliseconds */
  durationMs: int("duration_ms").default(0).notNull(),
  /** Human-readable summary */
  summary: varchar("summary", { length: 500 }).default("").notNull(),
});
export type PondPromotionLog = typeof pondPromotionLog.$inferSelect;
export type InsertPondPromotionLog = typeof pondPromotionLog.$inferInsert;

/**
 * Speed-to-lead timer tracking.
 * Each row represents a new lead that was assigned to an agent and is being
 * monitored for first-touch response time. Business rules:
 * - Timer starts when a new lead is detected (created in last 24h, assigned to non-Peter agent)
 * - Warning at 30 business minutes (FUB note + task created)
 * - Reassignment to Peter at 60 business minutes (lead reassigned + note)
 * - Timer canceled if agent touches the lead (call, text, email, note)
 *
 * Source: speed_to_lead heartbeat (fires every 5 min)
 */
export const speedToLeadTimers = mysqlTable("speed_to_lead_timers", {
  id: int("id").autoincrement().primaryKey(),
  /** FUB person ID */
  personId: int("person_id").notNull().unique(),
  /** FUB user ID of the assigned agent */
  assignedUserId: int("assigned_user_id").notNull(),
  /** Agent name for display/logging */
  agentName: varchar("agent_name", { length: 100 }).default("").notNull(),
  /** When the lead was created in FUB (ISO string) */
  leadCreatedAt: varchar("lead_created_at", { length: 30 }).notNull(),
  /** When the timer was started (our system) */
  timerStartedAt: timestamp("timer_started_at").defaultNow().notNull(),
  /** Status: active | warned | reassigned | canceled */
  status: varchar("status", { length: 20 }).default("active").notNull(),
  /** When the warning was sent (null if not yet warned) */
  warnedAt: timestamp("warned_at"),
  /** When the lead was reassigned (null if not yet) */
  reassignedAt: timestamp("reassigned_at"),
  /** When the timer was canceled (agent touched the lead) */
  canceledAt: timestamp("canceled_at"),
  /** Reason for cancellation */
  cancelReason: varchar("cancel_reason", { length: 100 }),
});
export type SpeedToLeadTimer = typeof speedToLeadTimers.$inferSelect;
export type InsertSpeedToLeadTimer = typeof speedToLeadTimers.$inferInsert;

/**
 * Annual Nurture Leads — leads who indicated they are no longer looking
 * to move to Texas (moved away, stopped searching, etc.) but are NOT
 * hostile opt-outs. They receive ONE friendly check-in email per year
 * asking for referrals and keeping the door open.
 *
 * Source: reply_intent_handler | pond_response_scan
 */
export const annualNurtureLeads = mysqlTable("annual_nurture_leads", {
  id: int("id").autoincrement().primaryKey(),
  /** FUB person ID */
  personId: int("person_id").notNull(),
  /** Lead's email address */
  email: varchar("email", { length: 320 }),
  /** Lead's name at time of enrollment */
  leadName: varchar("lead_name", { length: 200 }),
  /** The trigger text that caused enrollment (AI snippet) */
  triggerSnippet: varchar("trigger_snippet", { length: 500 }),
  /** AI confidence 0.0-1.0 */
  confidence: varchar("confidence", { length: 10 }),
  /** AI reason for classification */
  reason: varchar("reason", { length: 500 }),
  /** Which system enrolled them */
  source: varchar("source", { length: 80 }).notNull(),
  /** When they were enrolled in annual nurture */
  enrolledAt: timestamp("enrolled_at").defaultNow().notNull(),
  /** When the last annual email was sent (null = never sent yet) */
  lastEmailSentAt: timestamp("last_email_sent_at"),
  /** Total annual emails sent to this lead */
  emailsSent: int("emails_sent").notNull().default(0),
  /** Whether this enrollment is still active */
  active: boolean("active").notNull().default(true),
});
export type AnnualNurtureLead = typeof annualNurtureLeads.$inferSelect;
export type InsertAnnualNurtureLead = typeof annualNurtureLeads.$inferInsert;

/**
 * Per-lead audit log for agent bot emails.
 * Tracks every email sent by agent bots to prevent over-contacting
 * and to surface in the dashboard lead list view.
 */
export const contactedLeads = mysqlTable("contacted_leads", {
  id: int("id").autoincrement().primaryKey(),
  /** Which bot sent the email (slug) */
  botSlug: varchar("bot_slug", { length: 50 }).notNull(),
  /** Human-readable bot name */
  botName: varchar("bot_name", { length: 100 }).notNull(),
  /** FUB person ID */
  personId: int("person_id").notNull(),
  /** Lead first name */
  leadFirstName: varchar("lead_first_name", { length: 100 }),
  /** Lead last name */
  leadLastName: varchar("lead_last_name", { length: 100 }),
  /** Lead email address */
  leadEmail: varchar("lead_email", { length: 320 }),
  /** FUB stage at time of contact */
  stage: varchar("stage", { length: 100 }),
  /** How many days stale the lead was */
  daysStale: int("days_stale").notNull().default(0),
  /** The email body that was sent */
  messageBody: text("message_body"),
  /** When the email was sent */
  sentAt: timestamp("sent_at").defaultNow().notNull(),
});
export type ContactedLead = typeof contactedLeads.$inferSelect;
export type InsertContactedLead = typeof contactedLeads.$inferInsert;

/**
 * Power Queue 2.0 — AI SMS draft cache.
 * Stores Claude-generated SMS drafts per lead per day to avoid regenerating
 * on every page load (cost control). Cache key = personId + cacheDate.
 */
export const smsDraftCache = mysqlTable("sms_draft_cache", {
  id: int("id").autoincrement().primaryKey(),
  /** FUB person ID */
  personId: int("person_id").notNull(),
  /** Agent the draft was generated for */
  agentName: varchar("agent_name", { length: 100 }).notNull(),
  /** The AI-generated draft text */
  draftText: text("draft_text").notNull(),
  /** Cache date in CT (YYYY-MM-DD) — one draft per lead per day */
  cacheDate: varchar("cache_date", { length: 10 }).notNull(),
  /** Notes hash used to generate this draft (invalidate if notes change) */
  notesHash: varchar("notes_hash", { length: 64 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
export type SmsDraftCache = typeof smsDraftCache.$inferSelect;
export type InsertSmsDraftCache = typeof smsDraftCache.$inferInsert;

/**
 * Power Queue 2.0 — Lead snooze records.
 * When an agent snoozes a lead, it disappears from the queue until the
 * snooze date. A FUB note is written for audit trail.
 * Display-level only — does NOT pause pond timers or nurture.
 */
export const leadSnoozes = mysqlTable("lead_snoozes", {
  id: int("id").autoincrement().primaryKey(),
  /** FUB person ID */
  personId: int("person_id").notNull(),
  /** Agent who snoozed */
  agentName: varchar("agent_name", { length: 100 }).notNull(),
  /** When the lead should reappear in the queue (YYYY-MM-DD) */
  snoozeUntil: varchar("snooze_until", { length: 10 }).notNull(),
  /** Why the agent snoozed (optional) */
  reason: varchar("reason", { length: 200 }),
  /** Whether the FUB note was successfully written */
  fubNoteWritten: boolean("fub_note_written").default(false).notNull(),
  /** Lead name at time of snooze (for display) */
  leadName: varchar("lead_name", { length: 200 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
export type LeadSnooze = typeof leadSnoozes.$inferSelect;
export type InsertLeadSnooze = typeof leadSnoozes.$inferInsert;

/**
 * Power Queue 2.0 — Queue action tracking.
 * Records every action taken from the Power Queue for weekly digest stats.
 * Tracks: texted, called, snoozed, hot_lead_responded, completed.
 */
export const queueActions = mysqlTable("queue_actions", {
  id: int("id").autoincrement().primaryKey(),
  /** FUB person ID */
  personId: int("person_id").notNull(),
  /** Agent who took the action */
  agentName: varchar("agent_name", { length: 100 }).notNull(),
  /** Type of action: 'texted' | 'called' | 'snoozed' | 'hot_lead_responded' | 'completed' */
  actionType: varchar("action_type", { length: 30 }).notNull(),
  /** ISO week key for fast aggregation (e.g. '2026-W28') */
  weekKey: varchar("week_key", { length: 10 }).notNull(),
  /** Days stale at time of action (for avg calculation) */
  daysStale: int("days_stale").default(0).notNull(),
  /** Whether this was a hot/replied lead */
  isHotLead: boolean("is_hot_lead").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
export type QueueAction = typeof queueActions.$inferSelect;
export type InsertQueueAction = typeof queueActions.$inferInsert;

/**
 * Email angle rotation log.
 * Tracks the last angle used per lead to prevent repeating the same
 * approach two sends in a row. Used by the agent bot brain upgrade.
 */
export const emailAngleLog = mysqlTable("email_angle_log", {
  id: int("id").autoincrement().primaryKey(),
  /** FUB person ID */
  personId: int("person_id").notNull(),
  /** Last angle used (one of the 5 AGENT_BOT_ANGLES) */
  lastAngle: varchar("last_angle", { length: 200 }).notNull(),
  /** When this angle was last sent */
  sentAt: timestamp("sent_at").defaultNow().notNull(),
});
export type EmailAngleLog = typeof emailAngleLog.$inferSelect;
export type InsertEmailAngleLog = typeof emailAngleLog.$inferInsert;

/**
 * Stores detected purchase timeline windows per lead.
 * Re-extracted every send cycle — newer notes override older windows.
 */
export const purchaseWindow = mysqlTable("purchase_window", {
  id: int("id").autoincrement().primaryKey(),
  /** FUB person ID */
  personId: int("person_id").notNull().unique(),
  /** Detected earliest purchase date (when the lead plans to buy) */
  windowStart: timestamp("window_start").notNull(),
  /** The note date from which this window was extracted */
  detectedFromNoteDate: timestamp("detected_from_note_date"),
  /** Raw text that was parsed (for debugging) */
  rawText: varchar("raw_text", { length: 500 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
});
export type PurchaseWindow = typeof purchaseWindow.$inferSelect;
export type InsertPurchaseWindow = typeof purchaseWindow.$inferInsert;
