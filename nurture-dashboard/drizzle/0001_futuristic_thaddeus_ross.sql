CREATE TABLE `copilot_feedback` (
	`id` int AUTO_INCREMENT NOT NULL,
	`agent_name` varchar(100) NOT NULL,
	`draft_text` text NOT NULL,
	`lead_city` varchar(100),
	`lead_stage` varchar(100),
	`draft_type` varchar(20) NOT NULL DEFAULT 'outbound',
	`action` enum('sent','ignored','regenerated','edited') NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `copilot_feedback_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `copilot_memories` (
	`id` int AUTO_INCREMENT NOT NULL,
	`agent_name` varchar(100) NOT NULL,
	`memory_text` text NOT NULL,
	`category` varchar(50) NOT NULL DEFAULT 'general',
	`importance_score` int NOT NULL DEFAULT 1,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `copilot_memories_id` PRIMARY KEY(`id`)
);
