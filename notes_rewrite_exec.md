# REWRITE EXECUTION PLAN — Drive-Only Pipeline

## GOAL
Rebuild the entire pipeline so:
1. IG reels are scraped (via agent task with IG MCP) → stored in `ig_reels` table
2. Morning cron picks the best engagement reel per city NOT visually posted in 30 days
3. AI vision matches the picked reel's thumbnail to a Drive original
4. Downloads from Drive → applies variant → uploads to S3 → stores storage key on pick
5. Publish cron generates fresh signed URL from storage key → posts via Metricool
6. NO ID matching, NO caption fingerprint matching — PURE AI VISION ONLY

## TABLES (already created in DB)
- `ig_reels`: id, igMediaId (unique), thumbnailStorageKey, caption, views, likes, comments, shares, saved, engagementScore, city, reelLink, postedAt, lastScrapedAt, createdAt
- `post_history`: id, thumbnailStorageKey, caption, city, postedAt, createdAt
- `drive_videos`: driveFileId (PK), fileName, mimeType, sizeBytes, durationMs, width, height, thumbnailUrl, hostedThumbnailUrl, driveCreatedAt, lastIndexedAt
- `daily_picks`: id, pickDate, city, videoId, postId, refreshedCaption, selectionMode, scheduledFor, status, repostId, driveVideoUrl, driveMatchConfidence, createdAt, updatedAt
  - UNIQUE: (pickDate, city)
  - videoId and postId are still required columns (NOT NULL) — will repurpose: videoId = ig_reels.id, postId = ig_reels.igMediaId

## KEY DECISIONS
1. `daily_picks.videoId` → will store `ig_reels.id` (same int type)
2. `daily_picks.postId` → will store `ig_reels.igMediaId` (same varchar type)
3. `reposts` table → still used for history tracking, videoId/postId same meaning
4. Remove `sourceCooldown.ts` — replaced by AI vision dedup
5. Remove `igHistorySync.ts` caption-based dedup — keep only `isVisuallyDuplicate` pattern
6. `driveIndex.ts` → must use Google Drive API via fetch() (NOT gws CLI)
   - Token: process.env.GOOGLE_DRIVE_TOKEN || process.env.GOOGLE_WORKSPACE_CLI_TOKEN
   - Folder ID: 16mNnK1avek0LUljjFPZ5iNxON2OJZod7
7. `drivePreprocess.ts` → download via fetch (Drive API), not gws CLI
8. `driveMatcher.ts` → max_tokens MUST be 2048 (not 256!) for Gemini reasoning tokens
9. `igScraper.ts` → fix ordering: add `desc()` to engagementScore query

## FILES TO REWRITE
1. `server/db.ts` — add ig_reels/post_history helpers, keep daily_picks/reposts helpers
2. `server/selection.ts` — rewrite selectForCity to use ig_reels + AI vision dedup
3. `server/routers.ts` — rewrite ensureTodayPicks to use ig_reels + post_history
4. `server/driveIndex.ts` — replace gws CLI with Google Drive API fetch()
5. `server/drivePreprocess.ts` — use ig_reels thumbnail instead of old videos table
6. `server/scheduledPublish.ts` — remove sourceCooldown, remove legacy fallback, use ig_reels
7. `server/igScraper.ts` — fix desc() ordering

## KEY FUNCTION SIGNATURES TO PRESERVE
- `getCdtPickDate()` → string (YYYY-MM-DD)
- `defaultScheduleMs(pickDate, city)` → number (UTC ms)
- `isDallasDay(pickDate)` → boolean
- `findDriveMatch({ igThumbnailUrl, igCaption, igDurationMs })` → { matchedFileId, fileName, confidence } | null
- `makeDifferentiatedVariant({ sourceUrl, postId, salt, sourceBytes? })` → { ok, url?, storageKey?, error? }
- `storagePut(key, data, contentType)` → { key, url }
- `storageGetSignedUrl(key)` → string (full https URL)
- `optimizeHook(caption)` → { caption, hookChanged, ... }
- `refreshCaption(caption)` → string
- `classifyMarket(caption)` → "austin" | "san_antonio" | "dallas"

## DRIVE API (for driveIndex.ts rewrite)
```
const token = process.env.GOOGLE_DRIVE_TOKEN || process.env.GOOGLE_WORKSPACE_CLI_TOKEN;
const FOLDER_ID = "16mNnK1avek0LUljjFPZ5iNxON2OJZod7";
const FIELDS = "files(id,name,mimeType,size,videoMediaMetadata,thumbnailLink,createdTime),nextPageToken";

// List files
const url = `https://www.googleapis.com/drive/v3/files?q='${FOLDER_ID}'+in+parents&fields=${FIELDS}&pageSize=100`;
const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

// Download file
const dlUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
const resp = await fetch(dlUrl, { headers: { Authorization: `Bearer ${token}` } });
```

## AI VISION DEDUP (from igHistorySync.ts isVisuallyDuplicate)
- Compare candidate thumbnail against up to 10 recent post_history thumbnails
- Uses invokeLLM with image_url content type
- Returns { isDuplicate: boolean }
- Fail-open: if AI fails, don't block the pick

## FLOW SUMMARY
Morning 8AM CT (generatePicksHandler):
1. Read ig_reels by city, sorted by engagementScore DESC
2. For each city, try candidates in order:
   a. Get candidate thumbnail (storageGetSignedUrl from ig_reels.thumbnailStorageKey)
   b. Get recent post_history thumbnails (last 30 days, same city)
   c. AI vision: is candidate visually same as any recent post? → skip if yes
   d. If not duplicate → this is the pick
3. Insert daily_pick (videoId=igReel.id, postId=igReel.igMediaId)
4. Auto-confirm
5. Drive preprocess: match → download → variant → upload → store key

Publish 2/3/4PM CT (publishNowHandler):
1. Get pick with driveVideoUrl (storage key)
2. Generate fresh signed URL
3. Post via Metricool
4. Record in post_history (thumbnailStorageKey, caption, city, postedAt)
