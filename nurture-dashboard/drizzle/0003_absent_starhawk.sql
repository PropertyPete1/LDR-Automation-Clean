CREATE TABLE `sms_sent_today` (
	`id` int AUTO_INCREMENT NOT NULL,
	`person_id` int NOT NULL,
	`agent_name` varchar(100) NOT NULL DEFAULT 'unknown',
	`sent_date` varchar(10) NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `sms_sent_today_id` PRIMARY KEY(`id`)
);
