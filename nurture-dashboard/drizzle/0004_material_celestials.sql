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
CREATE TABLE `bot_run_log` (
	`id` int AUTO_INCREMENT NOT NULL,
	`run_at` timestamp NOT NULL DEFAULT (now()),
	`leads_texted` int NOT NULL DEFAULT 0,
	`leads_failed` int NOT NULL DEFAULT 0,
	`leads_evaluated` int NOT NULL DEFAULT 0,
	`email_sent` enum('yes','no','skipped') NOT NULL DEFAULT 'no',
	`summary` text,
	`triggered_by` enum('cron','manual') NOT NULL DEFAULT 'cron',
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `bot_run_log_id` PRIMARY KEY(`id`)
);
