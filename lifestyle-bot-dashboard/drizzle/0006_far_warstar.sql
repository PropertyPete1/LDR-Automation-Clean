CREATE TABLE `lead_skip_reviews` (
	`personId` int NOT NULL,
	`notesFingerprint` varchar(64) NOT NULL,
	`shouldSkip` boolean NOT NULL,
	`reason` text,
	`reviewedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `lead_skip_reviews_personId` PRIMARY KEY(`personId`)
);
