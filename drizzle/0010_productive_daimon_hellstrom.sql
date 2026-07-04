CREATE TABLE `ig_reels` (
	`id` int AUTO_INCREMENT NOT NULL,
	`igMediaId` varchar(64) NOT NULL,
	`thumbnailStorageKey` varchar(512),
	`caption` text,
	`views` int NOT NULL DEFAULT 0,
	`likes` int NOT NULL DEFAULT 0,
	`comments` int NOT NULL DEFAULT 0,
	`shares` int NOT NULL DEFAULT 0,
	`saved` int NOT NULL DEFAULT 0,
	`engagementScore` int NOT NULL DEFAULT 0,
	`city` enum('austin','san_antonio','dallas'),
	`reelLink` varchar(512),
	`postedAt` bigint,
	`lastScrapedAt` bigint,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `ig_reels_id` PRIMARY KEY(`id`),
	CONSTRAINT `ig_reels_igMediaId_unique` UNIQUE(`igMediaId`)
);
--> statement-breakpoint
CREATE TABLE `post_history` (
	`id` int AUTO_INCREMENT NOT NULL,
	`thumbnailStorageKey` varchar(512),
	`caption` text,
	`city` enum('austin','san_antonio','dallas'),
	`postedAt` bigint NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `post_history_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `daily_picks` ADD `driveVideoUrl` text;--> statement-breakpoint
ALTER TABLE `daily_picks` ADD `driveMatchConfidence` varchar(16);