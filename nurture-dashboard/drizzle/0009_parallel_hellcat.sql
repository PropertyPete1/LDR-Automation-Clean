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
