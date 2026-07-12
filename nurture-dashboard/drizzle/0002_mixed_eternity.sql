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
