CREATE TABLE `lead_memory` (
	`id` int AUTO_INCREMENT NOT NULL,
	`person_id` int NOT NULL,
	`agent_name` varchar(100) NOT NULL,
	`memory_text` text NOT NULL,
	`category` varchar(50) NOT NULL DEFAULT 'general',
	`importance_score` int NOT NULL DEFAULT 1,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `lead_memory_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `suppressed_leads` (
	`id` int AUTO_INCREMENT NOT NULL,
	`person_id` int NOT NULL,
	`email` varchar(320),
	`reason` enum('unsubscribe','bounce_no_phone','opt_out_reply','agent_marked','manual') NOT NULL,
	`source` varchar(80) NOT NULL,
	`lead_name` varchar(200),
	`agent_name` varchar(100),
	`suppressed_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `suppressed_leads_id` PRIMARY KEY(`id`)
);
