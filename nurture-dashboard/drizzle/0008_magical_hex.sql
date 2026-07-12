CREATE TABLE `pond_nurture_log` (
	`id` int AUTO_INCREMENT NOT NULL,
	`person_id` int NOT NULL,
	`city` varchar(100) NOT NULL DEFAULT 'Texas/general',
	`subject` varchar(500) NOT NULL,
	`sent_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `pond_nurture_log_id` PRIMARY KEY(`id`),
	CONSTRAINT `pond_nurture_log_person_id_unique` UNIQUE(`person_id`)
);
