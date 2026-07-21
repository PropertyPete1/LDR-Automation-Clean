CREATE TABLE `annual_nurture_leads` (
	`id` int AUTO_INCREMENT NOT NULL,
	`person_id` int NOT NULL,
	`email` varchar(320),
	`lead_name` varchar(200),
	`trigger_snippet` varchar(500),
	`confidence` varchar(10),
	`reason` varchar(500),
	`source` varchar(80) NOT NULL,
	`enrolled_at` timestamp NOT NULL DEFAULT (now()),
	`last_email_sent_at` timestamp,
	`emails_sent` int NOT NULL DEFAULT 0,
	`active` boolean NOT NULL DEFAULT true,
	CONSTRAINT `annual_nurture_leads_id` PRIMARY KEY(`id`)
);
