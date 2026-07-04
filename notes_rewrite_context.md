# Rewrite Context — Drive-Only Pipeline

## Architecture (NEW)
1. `ig_reels` table: scraped from IG MCP (igMediaId, thumbnailStorageKey, caption, views, likes, comments, shares, saved, engagementScore, city, reelLink, postedAt, lastScrapedAt)
2. `post_history` table: what we posted (thumbnailStorageKey, caption, city, postedAt)
3. `drive_videos` table: indexed from Drive folder (driveFileId PK, fileName, mimeType, sizeBytes, durationMs, width, height, thumbnailUrl, hostedThumbnailUrl, driveCreatedAt, lastIndexedAt)
4. `daily_picks` table: per-day selection (pickDate, city, videoId, postId, refreshedCaption, selectionMode, scheduledFor, status, repostId, driveVideoUrl=storageKey, driveMatchConfidence)

## Flow
- Morning 8AM CT: `generatePicksHandler` → `ensureTodayPicks(pickDate)` → `preprocessDriveOriginals()`
- `ensureTodayPicks`: for each city → get top engagement reels from ig_reels → AI vision dedup against post_history → pick → refresh caption → optimize hook → insert daily_pick → auto-confirm
- `preprocessDriveOriginals`: sync Drive index → for each confirmed pick without driveVideoUrl → get ig_reel thumbnail → AI vision match to Drive thumbnails → download from Drive → variant → upload to S3 → store storageKey on pick
- Publish 2/3/4PM CT: `publishNowHandler` → get pick → fresh signed URL from storageKey → Metricool post

## Key Functions to Preserve
- `storageGetSignedUrl(key)` → fresh presigned URL
- `storagePut(key, data, contentType)` → { key, url }
- `findDriveMatch({ igThumbnailUrl, igCaption, igDurationMs })` → { matchedFileId, fileName, confidence } | null
- `makeDifferentiatedVariant({ sourceUrl, postId, salt, sourceBytes? })` → { ok, url?, storageKey?, error? }
- `refreshCaption(caption)` → refreshed caption string
- `optimizeHook(caption)` → { caption, changed, reason? }
- `classifyMarket(caption)` → "austin" | "san_antonio" | "dallas"
- `createScheduledPost({ videoUrl, caption, publishAt, timezone, thumbnailUrl })` → { ok, postId?, error? }

## What to Remove
- `sourceCooldown.ts` — replaced by AI vision dedup against post_history
- `igHistorySync.ts` — replaced by post_history table + new dedup logic
- Old `videos` table references in db.ts (getVideosByCity, getAllVideos, getVideoById, bulkInsertVideos)
- Old `igPostHistory` references
- `syncIgHistoryHandler` endpoint

## What to Keep
- `driveMatcher.ts` — pure AI vision, already correct (fix max_tokens: 256 → 2048)
- `driveIndex.ts` — needs gws→fetch rewrite (use GOOGLE_WORKSPACE_CLI_TOKEN)
- `videoVariant.ts` — unchanged
- `hookOptimizer.ts` — unchanged
- `captionRefresh.ts` — unchanged
- `geoClassify.ts` — unchanged
- `metricool.ts` — unchanged
- `performanceAnalyst.ts` — unchanged

## driveIndex.ts Token Access
```
const token = process.env.GOOGLE_DRIVE_TOKEN || process.env.GOOGLE_WORKSPACE_CLI_TOKEN || "";
const DRIVE_FOLDER_ID = "16mNnK1avek0LUljjFPZ5iNxON2OJZod7";
```
Use Google Drive REST API v3 via fetch() with Bearer token.

## driveMatcher.ts Fix
Change `max_tokens: 256` → `max_tokens: 2048` (Gemini reasoning tokens eat the budget)

## Key Design Rules (from user)
- NO ID-based matching anywhere. Pure AI vision only.
- igMediaId in ig_reels is ONLY for scrape dedup (avoid re-scraping same post)
- Matching to Drive is ONLY by visual similarity (thumbnails)
- Dedup against post_history is ONLY by visual similarity (thumbnails)
- Caption intelligence (hook optimizer, caption refresh) stays exactly the same
- Drive is the ONLY video source. No IG copy download. No legacy fallback.

## Selection Logic (NEW)
- Get reels from ig_reels for city, sorted by engagementScore DESC
- For each candidate:
  - Get its hosted thumbnail (storageGetSignedUrl on thumbnailStorageKey)
  - Get recent post_history (last 30 days) with their hosted thumbnails
  - AI vision check: is this candidate visually similar to any recent post?
  - If not duplicate → pick it
- Then: refreshCaption → optimizeHook → insertDailyPick → autoConfirmPick

## autoConfirmPick (NEW)
- No longer references old `videos` table
- Gets reel from ig_reels instead
- Creates repost row with caption, views, thumbnail from ig_reels
- Inserts into post_history for future dedup

## publishNow (NEW)
- No longer references old `videos` table for caption fallback
- Caption comes from pick.refreshedCaption (already set at pick time)
- No sourceCooldown check (replaced by AI vision dedup at pick time)
- driveVideoUrl is a storageKey → storageGetSignedUrl at publish time
- No legacy IG-copy path
