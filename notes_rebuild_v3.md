# Rebuild Context — Drive-Only Pipeline (v3)

## Architecture (user directive, final)
1. Scrape IG → get reels with views, engagement, description, thumbnail
2. AI picks the best → highest engagement that hasn't posted in 30 days (visual dedup via AI)
3. AI vision finds the matching Drive original → looks at thumbnails, NOT IDs
4. Download from Drive → variant → upload to S3 → post the original

## Key Tables
- `ig_reels` — scraped IG reels (igMediaId PK unique, thumbnailStorageKey, caption, views, likes, comments, shares, saved, engagementScore, city, reelLink, postedAt, lastScrapedAt)
- `post_history` — what WE posted (thumbnailStorageKey, caption, city, postedAt) — for 30-day visual dedup
- `drive_videos` — indexed Drive files (driveFileId PK, fileName, mimeType, sizeBytes, durationMs, width, height, thumbnailUrl, hostedThumbnailUrl, driveCreatedAt, lastIndexedAt)
- `daily_picks` — today's picks (pickDate, city, videoId, postId, refreshedCaption, selectionMode, scheduledFor, status, repostId, driveVideoUrl, driveMatchConfidence)

## What Needs to Change in daily_picks
- `videoId` currently references old `videos` table → should reference `ig_reels.id`
- `postId` currently is IG media ID from old library → should be `ig_reels.igMediaId`
- These columns stay but their meaning changes to reference ig_reels

## Key Modules to Rewrite
1. `selection.ts` — keep utility functions (getCdtPickDate, cdtTimeToUtcMs, defaultScheduleMs, isDallasDay), rewrite selectForCity to use ig_reels
2. `routers.ts ensureTodayPicks` — pick from ig_reels by engagement, dedup against post_history using AI vision
3. `driveIndex.ts` — replace gws CLI with Google Drive API via fetch (using GOOGLE_WORKSPACE_CLI_TOKEN env var)
4. `drivePreprocess.ts` — use ig_reels instead of old videos table, download via Drive API fetch
5. `scheduledPublish.ts` — publishNow already works with driveVideoUrl (storage key → fresh signed URL)
6. `db.ts` — add helpers for ig_reels and post_history, keep existing helpers that still work

## Key Function Signatures
- `classifyMarket(caption?, onscreen?, thumbnailUrl?)` → "austin" | "san_antonio" | "dallas"
- `refreshCaption(caption: string)` → refreshed caption string
- `optimizeHook(caption: string)` → { caption, hookChanged, originalHook, newHook }
- `findDriveMatch({ igThumbnailUrl, igCaption, igDurationMs })` → { matchedFileId, fileName, confidence } | null
- `makeDifferentiatedVariant({ sourceUrl, postId, salt, sourceBytes? })` → { ok, url?, storageKey?, sha256?, error? }
- `storagePut(key, data, contentType)` → { key, url }
- `storageGetSignedUrl(key)` → signed URL string
- `computeEngagementScore({ views, likes, comments, shares, saved })` → number

## Drive API Access (production)
- Token: `process.env.GOOGLE_DRIVE_TOKEN || process.env.GOOGLE_WORKSPACE_CLI_TOKEN`
- List files: `GET https://www.googleapis.com/drive/v3/files?q='FOLDER_ID'+in+parents&fields=...`
- Download: `GET https://www.googleapis.com/drive/v3/files/{fileId}?alt=media`
- Auth header: `Authorization: Bearer ${token}`
- Folder ID: `16mNnK1avek0LUljjFPZ5iNxON2OJZod7`

## Endpoints (registered in _core/index.ts)
- POST /api/scheduled/generatePicks → generatePicksHandler
- POST /api/scheduled/dueForPublish → dueForPublishHandler
- POST /api/scheduled/publishNow → publishNowHandler
- POST /api/scheduled/syncIgHistory → syncIgHistoryHandler
- POST /api/scheduled/reportPublish → reportPublishHandler
- POST /api/scheduled/runAnalyst → runAnalystHandler

## New Endpoint Needed
- POST /api/scheduled/scrapeReels → scrapeReelsHandler (called by agent with IG MCP access)

## Source Cooldown (sourceCooldown.ts)
- Currently checks reposts table + ig_post_history by postId OR caption fingerprint
- In new system: should check post_history table by caption fingerprint (no postId matching since we don't use IDs)
- Keep caption fingerprint matching, remove postId matching

## Visual Dedup (igHistorySync.ts isVisuallyDuplicate)
- Compares candidate thumbnail against up to 10 recent post thumbnails via AI vision
- In new system: compare ig_reels thumbnail against post_history thumbnails
- Both use hosted thumbnails (storage keys → signed URLs) so they never expire

## Morning Job Flow (NEW)
1. Agent calls /api/scheduled/scrapeReels with fresh IG data (reels + insights)
2. System upserts ig_reels, classifies cities, hosts thumbnails
3. Agent calls /api/scheduled/generatePicks
4. System picks best engagement reel per city from ig_reels
5. AI visual dedup against post_history (last 30 days)
6. AI vision matches pick to Drive original
7. Downloads from Drive, applies variant, uploads to S3
8. Stores storage key on daily_pick
9. At 2/3/4 PM: publishNow generates fresh signed URL and posts via Metricool

## igScraper.ts (already written)
- `upsertScrapedReels(reels: ScrapedReel[])` — upserts into ig_reels, classifies city, hosts thumbnail
- `getReelsByCity(city)` — returns reels for a city ordered by engagement
- `getAllReels()` — returns all reels
- `computeEngagementScore(reel)` — views + likes*10 + comments*20 + shares*30 + saved*15

## driveMatcher.ts (already written, pure AI vision)
- `findDriveMatch({ igThumbnailUrl, igCaption, igDurationMs })` → MatchResult | null
- Uses gemini-3-flash-preview, batches of 5 Drive thumbnails
- Only accepts high/medium confidence
- max_tokens: 256 (was fixed to 2048 but file shows 256 — need to check)

## IMPORTANT USER DIRECTIVES
- NO ID-based matching anywhere. Pure AI vision intelligence only.
- Captions stay the same (slight AI variation already in place)
- AI pick intelligence stays exactly as-is
- Remove all old data so it stops popping up
- No more posting Instagram downloaded videos — Drive originals ONLY
