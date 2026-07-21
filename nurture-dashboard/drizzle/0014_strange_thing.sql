CREATE TABLE `email_angle_log` (
	`id` int AUTO_INCREMENT NOT NULL,
	`person_id` int NOT NULL,
	`last_angle` varchar(200) NOT NULL,
	`sent_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `email_angle_log_id` PRIMARY KEY(`id`)
);
