CREATE TABLE `agent_bots` (
	`id` int AUTO_INCREMENT NOT NULL,
	`botSlug` varchar(50) NOT NULL,
	`botName` varchar(200) NOT NULL,
	`agentFirstName` varchar(100) NOT NULL,
	`agentLastName` varchar(100) NOT NULL DEFAULT '',
	`agentEmail` varchar(320) NOT NULL,
	`fubUserId` int NOT NULL,
	`powerQueueName` varchar(100),
	`accentColor` varchar(20) NOT NULL DEFAULT '#2c5f2e',
	`headerGradient` varchar(300) NOT NULL DEFAULT 'linear-gradient(135deg,#1a3d1c 0%,#2c5f2e 60%,#3a7d3c 100%)',
	`engineActive` boolean NOT NULL DEFAULT false,
	`introSentAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `agent_bots_id` PRIMARY KEY(`id`),
	CONSTRAINT `agent_bots_botSlug_unique` UNIQUE(`botSlug`)
);
--> statement-breakpoint
CREATE TABLE `annual_nurture_leads` (
	`id` int AUTO_INCREMENT NOT NULL,
	`person_id` int NOT NULL,
	`email` varchar(320),
	`lead_name` varchar(200),
	`trigger_snippet` varchar(500),
	`confidence` varchar(10),
	`reason` varchar(500),
	`source` varchar(80) NOT NULL,
	`enrolled_at` timestamp NOT NULL DEFAULT (now()),
	`last_email_sent_at` timestamp,
	`emails_sent` int NOT NULL DEFAULT 0,
	`active` boolean NOT NULL DEFAULT true,
	CONSTRAINT `annual_nurture_leads_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `bot_monitor_log` (
	`id` int AUTO_INCREMENT NOT NULL,
	`run_at` timestamp NOT NULL DEFAULT (now()),
	`checks_run` int NOT NULL DEFAULT 0,
	`issues_found` int NOT NULL DEFAULT 0,
	`issues_fixed` int NOT NULL DEFAULT 0,
	`findings` text,
	`summary` text,
	`triggered_by` varchar(20) NOT NULL DEFAULT 'cron',
	`duration_ms` int NOT NULL DEFAULT 0,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `bot_monitor_log_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `copilot_feedback` (
	`id` int AUTO_INCREMENT NOT NULL,
	`agent_name` varchar(100) NOT NULL,
	`draft_text` text NOT NULL,
	`lead_city` varchar(100),
	`lead_stage` varchar(100),
	`draft_type` varchar(20) NOT NULL DEFAULT 'outbound',
	`action` enum('sent','ignored','regenerated','edited') NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `copilot_feedback_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `copilot_memories` (
	`id` int AUTO_INCREMENT NOT NULL,
	`agent_name` varchar(100) NOT NULL,
	`memory_text` text NOT NULL,
	`category` varchar(50) NOT NULL DEFAULT 'general',
	`importance_score` int NOT NULL DEFAULT 1,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `copilot_memories_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `lead_memory` (
	`id` int AUTO_INCREMENT NOT NULL,
	`person_id` int NOT NULL,
	`agent_name` varchar(100) NOT NULL,
	`memory_text` text NOT NULL,
	`category` varchar(50) NOT NULL DEFAULT 'general',
	`importance_score` int NOT NULL DEFAULT 1,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `lead_memory_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `lead_snoozes` (
	`id` int AUTO_INCREMENT NOT NULL,
	`person_id` int NOT NULL,
	`agent_name` varchar(100) NOT NULL,
	`snooze_until` varchar(10) NOT NULL,
	`reason` varchar(200),
	`fub_note_written` boolean NOT NULL DEFAULT false,
	`lead_name` varchar(200),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `lead_snoozes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `pond_nurture_log` (
	`id` int AUTO_INCREMENT NOT NULL,
	`person_id` int NOT NULL,
	`city` varchar(100) NOT NULL DEFAULT 'Texas/general',
	`subject` varchar(500) NOT NULL,
	`sent_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `pond_nurture_log_id` PRIMARY KEY(`id`),
	CONSTRAINT `pond_nurture_log_person_id_unique` UNIQUE(`person_id`)
);
--> statement-breakpoint
CREATE TABLE `pond_promotion_log` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ran_at` timestamp NOT NULL DEFAULT (now()),
	`promoted` int NOT NULL DEFAULT 0,
	`skipped` int NOT NULL DEFAULT 0,
	`errors` int NOT NULL DEFAULT 0,
	`triggered_by` varchar(20) NOT NULL DEFAULT 'cron',
	`duration_ms` int NOT NULL DEFAULT 0,
	`summary` varchar(500) NOT NULL DEFAULT '',
	CONSTRAINT `pond_promotion_log_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `purchase_window` (
	`id` int AUTO_INCREMENT NOT NULL,
	`person_id` int NOT NULL,
	`window_start` timestamp NOT NULL,
	`detected_from_note_date` timestamp,
	`raw_text` varchar(500),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `purchase_window_id` PRIMARY KEY(`id`),
	CONSTRAINT `purchase_window_person_id_unique` UNIQUE(`person_id`)
);
--> statement-breakpoint
CREATE TABLE `queue_actions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`person_id` int NOT NULL,
	`agent_name` varchar(100) NOT NULL,
	`action_type` varchar(30) NOT NULL,
	`week_key` varchar(10) NOT NULL,
	`days_stale` int NOT NULL DEFAULT 0,
	`is_hot_lead` boolean NOT NULL DEFAULT false,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `queue_actions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `reply_intent_processed` (
	`id` int AUTO_INCREMENT NOT NULL,
	`gmail_message_id` varchar(64) NOT NULL,
	`sender_email` varchar(320) NOT NULL,
	`fub_person_id` int,
	`action` varchar(50) NOT NULL,
	`confidence` varchar(10),
	`reason` varchar(500),
	`processed_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `reply_intent_processed_id` PRIMARY KEY(`id`),
	CONSTRAINT `reply_intent_processed_gmail_message_id_unique` UNIQUE(`gmail_message_id`)
);
--> statement-breakpoint
CREATE TABLE `sms_draft_cache` (
	`id` int AUTO_INCREMENT NOT NULL,
	`person_id` int NOT NULL,
	`agent_name` varchar(100) NOT NULL,
	`draft_text` text NOT NULL,
	`cache_date` varchar(10) NOT NULL,
	`notes_hash` varchar(64),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `sms_draft_cache_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `speed_to_lead_timers` (
	`id` int AUTO_INCREMENT NOT NULL,
	`person_id` int NOT NULL,
	`assigned_user_id` int NOT NULL,
	`agent_name` varchar(100) NOT NULL DEFAULT '',
	`lead_created_at` varchar(30) NOT NULL,
	`timer_started_at` timestamp NOT NULL DEFAULT (now()),
	`status` varchar(20) NOT NULL DEFAULT 'active',
	`warned_at` timestamp,
	`reassigned_at` timestamp,
	`canceled_at` timestamp,
	`cancel_reason` varchar(100),
	CONSTRAINT `speed_to_lead_timers_id` PRIMARY KEY(`id`),
	CONSTRAINT `speed_to_lead_timers_person_id_unique` UNIQUE(`person_id`)
);
--> statement-breakpoint
CREATE TABLE `suppressed_leads` (
	`id` int AUTO_INCREMENT NOT NULL,
	`person_id` int NOT NULL,
	`email` varchar(320),
	`reason` enum('unsubscribe','bounce_no_phone','opt_out_reply','agent_marked','manual') NOT NULL,
	`source` varchar(80) NOT NULL,
	`lead_name` varchar(200),
	`agent_name` varchar(100),
	`suppressed_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `suppressed_leads_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `ui_error_log` (
	`id` int AUTO_INCREMENT NOT NULL,
	`actor` varchar(100) NOT NULL DEFAULT 'unknown',
	`action` varchar(200) NOT NULL,
	`error_message` text NOT NULL,
	`error_detail` text,
	`category` varchar(50) NOT NULL DEFAULT 'other',
	`resolved` enum('no','yes','unfixable') NOT NULL DEFAULT 'no',
	`fix_applied` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`resolved_at` timestamp,
	CONSTRAINT `ui_error_log_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `email_angle_log` DROP INDEX `email_angle_log_personId_unique`;--> statement-breakpoint
ALTER TABLE `sms_sent_today` DROP INDEX `sms_sent_today_personId_unique`;--> statement-breakpoint
ALTER TABLE `bot_observations` MODIFY COLUMN `source` varchar(50) NOT NULL;--> statement-breakpoint
ALTER TABLE `bot_observations` MODIFY COLUMN `category` varchar(80) NOT NULL;--> statement-breakpoint
ALTER TABLE `bot_observations` MODIFY COLUMN `severity` enum('info','warning','error','fixed') NOT NULL;--> statement-breakpoint
ALTER TABLE `bot_observations` MODIFY COLUMN `message` varchar(255) NOT NULL;--> statement-breakpoint
ALTER TABLE `bot_observations` MODIFY COLUMN `resolved` int NOT NULL;--> statement-breakpoint
ALTER TABLE `bot_observations` MODIFY COLUMN `resolved` int NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `bot_run_logs` MODIFY COLUMN `botName` varchar(200) NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE `bot_run_logs` MODIFY COLUMN `botSlug` varchar(100) NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE `bot_run_logs` MODIFY COLUMN `status` varchar(50) NOT NULL DEFAULT 'ok';--> statement-breakpoint
ALTER TABLE `contacted_leads` MODIFY COLUMN `botSlug` varchar(50) NOT NULL;--> statement-breakpoint
ALTER TABLE `contacted_leads` MODIFY COLUMN `botName` varchar(100) NOT NULL;--> statement-breakpoint
ALTER TABLE `contacted_leads` MODIFY COLUMN `leadFirstName` varchar(100);--> statement-breakpoint
ALTER TABLE `contacted_leads` MODIFY COLUMN `leadLastName` varchar(100);--> statement-breakpoint
ALTER TABLE `contacted_leads` MODIFY COLUMN `stage` varchar(100);--> statement-breakpoint
ALTER TABLE `sms_sent_today` MODIFY COLUMN `agentName` varchar(100) NOT NULL DEFAULT 'unknown';--> statement-breakpoint
ALTER TABLE `email_angle_log` ADD `person_id` int NOT NULL;--> statement-breakpoint
ALTER TABLE `email_angle_log` ADD `last_angle` varchar(200) NOT NULL;--> statement-breakpoint
ALTER TABLE `email_angle_log` ADD `sent_at` timestamp DEFAULT (now()) NOT NULL;--> statement-breakpoint
ALTER TABLE `email_angle_log` DROP COLUMN `personId`;--> statement-breakpoint
ALTER TABLE `email_angle_log` DROP COLUMN `lastAngle`;--> statement-breakpoint
ALTER TABLE `email_angle_log` DROP COLUMN `sentAt`;