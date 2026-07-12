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
