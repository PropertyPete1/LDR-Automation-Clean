CREATE TABLE `drive_videos` (
	`driveFileId` varchar(64) NOT NULL,
	`fileName` varchar(512) NOT NULL,
	`mimeType` varchar(64),
	`sizeBytes` bigint,
	`durationMs` bigint,
	`width` int,
	`height` int,
	`thumbnailUrl` varchar(1024),
	`hostedThumbnailUrl` varchar(512),
	`driveCreatedAt` bigint,
	`lastIndexedAt` bigint NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `drive_videos_driveFileId` PRIMARY KEY(`driveFileId`)
);
