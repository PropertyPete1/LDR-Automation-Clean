CREATE TABLE `bot_observations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`source` varchar(64) NOT NULL,
	`category` enum('run_start','run_complete','lead_error','bot_crash','fixed') NOT NULL,
	`severity` enum('info','warning','error') NOT NULL,
	`message` text NOT NULL,
	`resolved` boolean NOT NULL DEFAULT false,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `bot_observations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `bot_run_logs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`botName` varchar(128) NOT NULL,
	`botSlug` varchar(64) NOT NULL,
	`sent` int NOT NULL DEFAULT 0,
	`errored` int NOT NULL DEFAULT 0,
	`skipped` int NOT NULL DEFAULT 0,
	`status` enum('ok','warning','error') NOT NULL DEFAULT 'ok',
	`ranAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `bot_run_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sms_sent_today` (
	`id` int AUTO_INCREMENT NOT NULL,
	`personId` int NOT NULL,
	`agentName` varchar(128) NOT NULL,
	`sentAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `sms_sent_today_id` PRIMARY KEY(`id`),
	CONSTRAINT `sms_sent_today_personId_unique` UNIQUE(`personId`)
);
