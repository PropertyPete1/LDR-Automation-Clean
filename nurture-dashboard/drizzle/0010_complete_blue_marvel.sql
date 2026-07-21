CREATE TABLE `speed_to_lead_timers` (
	`id` int AUTO_INCREMENT NOT NULL,
	`person_id` int NOT NULL,
	`assigned_user_id` int NOT NULL,
	`agent_name` varchar(100) NOT NULL DEFAULT '',
	`lead_created_at` varchar(30) NOT NULL,
	`timer_started_at` timestamp NOT NULL DEFAULT (now()),
	`status` varchar(20) NOT NULL DEFAULT 'active',
	`warned_at` timestamp,
	`reassigned_at` timestamp,
	`canceled_at` timestamp,
	`cancel_reason` varchar(100),
	CONSTRAINT `speed_to_lead_timers_id` PRIMARY KEY(`id`),
	CONSTRAINT `speed_to_lead_timers_person_id_unique` UNIQUE(`person_id`)
);
