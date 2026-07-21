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
