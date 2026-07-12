CREATE TABLE `contacted_leads` (
	`id` int AUTO_INCREMENT NOT NULL,
	`botSlug` varchar(64) NOT NULL,
	`botName` varchar(128) NOT NULL,
	`personId` int NOT NULL,
	`leadFirstName` varchar(128),
	`leadLastName` varchar(128),
	`leadEmail` varchar(320),
	`stage` varchar(128),
	`daysStale` int NOT NULL DEFAULT 0,
	`messageBody` text,
	`sentAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `contacted_leads_id` PRIMARY KEY(`id`)
);
