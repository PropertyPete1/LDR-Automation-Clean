CREATE TABLE `email_angle_log` (
	`id` int AUTO_INCREMENT NOT NULL,
	`personId` int NOT NULL,
	`lastAngle` varchar(128) NOT NULL,
	`sentAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `email_angle_log_id` PRIMARY KEY(`id`),
	CONSTRAINT `email_angle_log_personId_unique` UNIQUE(`personId`)
);
