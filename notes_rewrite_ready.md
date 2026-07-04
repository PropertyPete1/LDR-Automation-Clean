# REWRITE READY — All Context Gathered

## Files to Rewrite (in order)

### 1. driveIndex.ts — Replace gws CLI with Google Drive REST API
- Replace `execSync("gws drive files list ...")` with `fetch("https://www.googleapis.com/drive/v3/files?...")`
- Token: `process.env.GOOGLE_DRIVE_TOKEN || process.env.GOOGLE_WORKSPACE_CLI_TOKEN`
- Keep: DRIVE_FOLDER_ID, FIELDS, DriveFile interface, syncDriveIndex, getAllDriveVideos, getDriveVideosByDuration
- Add: `downloadDriveFile(fileId)` that returns Buffer (move from drivePreprocess.ts)

### 2. drivePreprocess.ts — Use ig_reels instead of old videos table
- Replace `db.getVideoById(pick.videoId)` with `db.getReelById(pick.videoId)` (new helper)
- Use `reel.thumbnailStorageKey` → convert to signed URL via `storageGetSignedUrl()`
- Replace `gws` download with `downloadDriveFile()` from driveIndex.ts (fetch-based)
- Keep: preprocessPick structure, variant logic, cleanup, PreprocessResult interface

### 3. selection.ts — Keep utilities, replace selectForCity
- KEEP: getCdtPickDate, cdtTimeToUtcMs, scheduleHourFor, defaultScheduleMs, isDallasDay
- REPLACE: selectForCity → new function that picks from ig_reels by engagementScore

### 4. db.ts — Add new helpers, remove old videos helpers
- ADD: getReelById(id), getReelsByCity(city), getRecentPostHistory(days=30), insertPostHistory(row)
- MODIFY: autoConfirmPick → use igReels instead of videos table for caption/thumbnail
- REMOVE: getVideosByCity, getAllVideos, getVideoById, countVideos, bulkInsertVideos
- KEEP: users, settings, reposts, dailyPicks, metrics, linkedin, analyst helpers

### 5. routers.ts — Rewrite ensureTodayPicks
- Replace old flow with:
  1. Get ig_reels for city (by engagementScore DESC) via new db helper
  2. Get post_history last 30 days via new db helper
  3. For each candidate reel: AI vision compare reel.thumbnailStorageKey vs post_history thumbnails
  4. Pick the first one that passes
  5. refreshCaption + optimizeHook
  6. insertDailyPick (videoId = igReel.id, postId = igReel.igMediaId)
  7. autoConfirmPick
- Update library router to use igReels
- Update picks.today to use getReelById instead of getVideoById

### 6. scheduledPublish.ts — Clean up
- dueForPublishHandler: replace db.getVideoById(pick.videoId) with db.getReelById(pick.videoId)
- publishNowHandler: 
  - Remove sourceCooldown import and check
  - Remove legacy variant path (Drive originals already varianted)
  - After successful publish: insert into post_history
- Remove syncIgHistoryHandler (or make it a no-op)
- Add scrapeReelsHandler endpoint

### 7. sourceCooldown.ts — DELETE (replaced by AI vision dedup at pick time)

### 8. igHistorySync.ts — Keep isVisuallyDuplicate, remove old sync functions

## Key Function Signatures

### isVisuallyDuplicate (keep, adapt for post_history)
```ts
async function isVisuallyDuplicate(
  candidateThumbnailUrl: string,
  recentPosts: Array<{ igPostId: string; thumbnailUrl: string | null; captionSnippet: string | null; postedAt: number }>,
  candidateCaption?: string | null
): Promise<boolean>
```
Need to adapt the interface to accept post_history rows instead of ig_post_history rows.

### findDriveMatch (keep as-is)
```ts
async function findDriveMatch(opts: {
  igThumbnailUrl: string;
  igCaption?: string | null;
  igDurationMs?: number | null;
}): Promise<{ matchedFileId: string; fileName: string; confidence: "high" | "medium" | "low" } | null>
```

### makeDifferentiatedVariant (keep as-is)
```ts
async function makeDifferentiatedVariant(opts: {
  sourceUrl: string;
  postId: string;
  salt: string;
  sourceBytes?: Buffer;
}): Promise<VariantResult>
// VariantResult: { ok: boolean; url?: string; storageKey?: string; sha256?: string; error?: string }
```

### refreshCaption (keep as-is)
```ts
async function refreshCaption(originalCaption: string): Promise<string>
```

### optimizeHook (keep as-is)
```ts
async function optimizeHook(caption: string, brandLabel?: string): Promise<{ caption: string; changed: boolean; reason?: string }>
```

### storageGetSignedUrl (keep as-is)
```ts
async function storageGetSignedUrl(key: string, expiresIn?: number): Promise<string>
```

## Schema References
- igReels: id, igMediaId, thumbnailStorageKey, caption, views, likes, comments, shares, saved, engagementScore, city, reelLink, postedAt, lastScrapedAt
- postHistory: id, thumbnailStorageKey, caption, city, postedAt
- dailyPicks: id, pickDate, city, videoId, postId, refreshedCaption, selectionMode, scheduledFor, status, repostId, driveVideoUrl (storageKey), driveMatchConfidence
- driveVideos: driveFileId (PK), fileName, mimeType, sizeBytes, durationMs, width, height, thumbnailUrl, hostedThumbnailUrl, driveCreatedAt, lastIndexedAt

## Import References
- drizzle-orm: eq, desc, and, gte, sql
- Schema: igReels, postHistory, driveVideos, dailyPicks, reposts, users, etc.
- invokeLLM from "./_core/llm"
- storagePut, storageGetSignedUrl from "./storage"
