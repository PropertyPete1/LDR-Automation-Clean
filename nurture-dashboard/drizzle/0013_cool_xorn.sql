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
