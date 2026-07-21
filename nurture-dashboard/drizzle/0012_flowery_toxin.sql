CREATE TABLE `contacted_leads` (
	`id` int AUTO_INCREMENT NOT NULL,
	`bot_slug` varchar(50) NOT NULL,
	`bot_name` varchar(100) NOT NULL,
	`person_id` int NOT NULL,
	`lead_first_name` varchar(100),
	`lead_last_name` varchar(100),
	`lead_email` varchar(320),
	`stage` varchar(100),
	`days_stale` int NOT NULL DEFAULT 0,
	`message_body` text,
	`sent_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `contacted_leads_id` PRIMARY KEY(`id`)
);
