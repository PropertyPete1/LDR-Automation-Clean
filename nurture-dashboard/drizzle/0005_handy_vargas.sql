CREATE TABLE `bot_observations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`source` varchar(50) NOT NULL,
	`severity` enum('info','warning','error','fixed') NOT NULL,
	`category` varchar(80) NOT NULL,
	`message` varchar(255) NOT NULL,
	`detail` text,
	`auto_fixable` int NOT NULL DEFAULT 0,
	`fixed_at` timestamp,
	`fix_note` text,
	`run_id` varchar(64),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `bot_observations_id` PRIMARY KEY(`id`)
);
