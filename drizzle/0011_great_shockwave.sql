CREATE TABLE `voiceover_budget` (
	`id` int AUTO_INCREMENT NOT NULL,
	`month` varchar(7) NOT NULL,
	`charactersUsed` int NOT NULL DEFAULT 0,
	`budgetLimit` int NOT NULL DEFAULT 100000,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `voiceover_budget_id` PRIMARY KEY(`id`),
	CONSTRAINT `voiceover_budget_month_unique` UNIQUE(`month`)
);
--> statement-breakpoint
CREATE TABLE `voiceover_jobs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`pickId` int NOT NULL,
	`reelId` int,
	`city` enum('austin','san_antonio','dallas') NOT NULL,
	`status` enum('detecting','scripting','pending_approval','generating_audio','duration_mismatch','rendering','preview_ready','approved','failed') NOT NULL DEFAULT 'detecting',
	`audioType` varchar(16),
	`originalAudioMode` enum('duck','mute') NOT NULL DEFAULT 'duck',
	`videoDurationSec` int,
	`script` text,
	`voiceId` varchar(64),
	`charactersUsed` int NOT NULL DEFAULT 0,
	`audioDurationSec` int,
	`durationMismatchPct` int,
	`audioStorageKey` varchar(512),
	`renderedVideoStorageKey` varchar(512),
	`driveRenderedFileId` varchar(64),
	`errorMessage` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `voiceover_jobs_id` PRIMARY KEY(`id`)
);
