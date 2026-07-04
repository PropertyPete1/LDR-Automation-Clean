# Complete Rebuild Context — Drive-Only Pipeline

## THE NEW FLOW (user's words)
1. Scrape IG → get reels with views, engagement, description
2. AI picks the best → highest engagement that hasn't posted in 30 days
3. AI vision finds the matching Drive original → looks at what the video looks like (thumbnails), NOT IDs
4. Download from Drive → post the original
5. Caption: use the IG description (with slight hook refresh)

## KEY RULE: NO ID-BASED MATCHING ANYWHERE. Pure AI vision only.

## TABLES

### ig_reels (new, already created in DB)
- id (PK auto), igMediaId (unique, internal scrape dedup ONLY), thumbnailStorageKey, caption, views, likes, comments, shares, saved, engagementScore, city, reelLink, postedAt, lastScrapedAt

### post_history (new, already created in DB)
- id (PK auto), thumbnailStorageKey, caption, city, postedAt

### daily_picks (existing)
- videoId → now points to ig_reels.id
- postId → varchar(32), store ig_reels.igMediaId (internal only)
- driveVideoUrl → S3 storage key (not signed URL)
- driveMatchConfidence → "high"|"medium"|null

### drive_videos (existing, 411 rows indexed)
- driveFileId PK, fileName, mimeType, sizeBytes, durationMs, width, height, thumbnailUrl, hostedThumbnailUrl, driveCreatedAt, lastIndexedAt

## MODULES TO REWRITE

### 1. server/igScraper.ts (DONE but needs ordering fix)
- `upsertScrapedReels(reels: ScrapedReel[])` — upserts into ig_reels with engagement score + city classification + hosted thumbnail
- `getReelsByCity(city)` — BUG: orders ASC not DESC. Fix: add `desc()` import and use `desc(igReels.engagementScore)`
- `getAllReels()` — no ordering
- `computeEngagementScore(reel)` — views + likes*10 + comments*20 + shares*30 + saved*15
- NOTE: MCP tools (get_post_list, get_post_insights) are sandbox-only. The scrape must happen via a scheduled Manus agent task. The heartbeat cron just reads from ig_reels.

### 2. server/selection.ts (REWRITE)
- KEEP: getCdtPickDate, cdtTimeToUtcMs, defaultScheduleMs, isDallasDay, scheduleHourFor, Market type, NO_REPEAT_DAYS, DAY_MS
- REMOVE: selectForCity (uses old Video type + postId-based cooldown)
- ADD: nothing needed here — selection logic moves into ensureTodayPicks directly

### 3. server/routers.ts ensureTodayPicks (REWRITE)
- NEW FLOW:
  1. Load ig_reels by city (from igScraper.getReelsByCity) — sorted by engagement DESC
  2. Load post_history last 30 days
  3. For each city, iterate reels by engagement
  4. AI vision dedup: compare reel thumbnail (signed URL from thumbnailStorageKey) vs post_history thumbnails
  5. Pick first non-duplicate
  6. refreshCaption → optimizeHook → insertDailyPick
  7. Auto-confirm
  8. Drive preprocessing (match → download → variant → upload)

### 4. server/db.ts (ADD new helpers)
- `getReelById(id: number)` — select from igReels where id = ?
- `getRecentPostHistory(days: number)` — select from postHistory where postedAt > cutoff
- `insertPostHistory(row)` — insert into postHistory
- CHANGE `autoConfirmPick`: replace `getVideoById(pick.videoId)` with `getReelById(pick.videoId)`

### 5. server/driveIndex.ts (REWRITE — replace gws CLI with fetch API)
- Token: `process.env.GOOGLE_WORKSPACE_CLI_TOKEN || process.env.GOOGLE_DRIVE_TOKEN`
- List: `https://www.googleapis.com/drive/v3/files?q='FOLDER_ID'+in+parents&fields=...&pageSize=100`
- Download: `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`
- FOLDER_ID: `16mNnK1avek0LUljjFPZ5iNxON2OJZod7`

### 6. server/drivePreprocess.ts (REWRITE)
- Replace gws download with fetch() to Drive API
- Replace `db.getVideoById(pick.videoId)` with `getReelById`
- Get thumbnail URL from `storageGetSignedUrl(reel.thumbnailStorageKey)` for AI vision matching

### 7. server/scheduledPublish.ts (CLEANUP)
- REMOVE: import of `checkSourceCooldown` and GUARD 1 (lines 184-210)
- REMOVE: import of `syncIgPostHistory`
- REMOVE: legacy variant path in GUARD 2 (lines 226-243) — only Drive originals now
- UPDATE: `dueForPublishHandler` — replace `db.getVideoById(pick.videoId)` with `getReelById`
- UPDATE: `publishNowHandler` — replace `db.getVideoById(pick.videoId)` with `getReelById`
- ADD: after successful publish, insert into post_history (thumbnail + caption + city + postedAt)

### 8. DELETE server/sourceCooldown.ts — no longer needed
### 9. REWRITE server/igHistorySync.ts — keep ONLY `isVisuallyDuplicate` function, adapt interface

## FUNCTION SIGNATURES (for reference)
```
refreshCaption(caption: string): Promise<string>
optimizeHook(caption: string, brandLabel?: string): Promise<{ caption: string; changed: boolean; reason?: string }>
classifyMarket(caption?: string | null, onscreen?: string | null, thumbnailUrl?: string | null): Promise<Market>
findDriveMatch({ igThumbnailUrl, igCaption, igDurationMs }): Promise<MatchResult | null>
  MatchResult: { matchedFileId: string; fileName: string; confidence: "high"|"medium" }
makeDifferentiatedVariant({ sourceUrl, postId, salt, sourceBytes? }): Promise<{ ok, url, storageKey, sha256, error }>
storagePut(relKey, data, contentType): Promise<{ key, url }>
storageGetSignedUrl(relKey): Promise<string>  // returns full signed URL
```

## VISUAL DEDUP (adapted from igHistorySync.isVisuallyDuplicate)
- Input: candidateThumbnailUrl (signed URL), recentPosts (post_history with thumbnailStorageKey)
- Convert post_history thumbnailStorageKeys to signed URLs before passing to LLM
- Uses gemini vision to compare thumbnails
- Returns boolean: true = duplicate (skip), false = fresh (safe to pick)

## ENDPOINTS (server/_core/index.ts)
- POST /api/scheduled/dueForPublish → dueForPublishHandler
- POST /api/scheduled/publishNow → publishNowHandler
- POST /api/scheduled/reportPublish → reportPublishHandler
- POST /api/scheduled/syncIgHistory → syncIgHistoryHandler (can be removed or repurposed)
- POST /api/scheduled/runAnalyst → runAnalystHandler
- POST /api/scheduled/generatePicks → generatePicksHandler

## SCRAPE STRATEGY
The IG MCP tools (get_post_list, get_post_insights) are only available in the sandbox/agent context, NOT in the deployed production runtime. So:
1. A scheduled Manus agent task scrapes IG → calls a new endpoint `/api/scheduled/scrapeReels` that upserts into ig_reels
2. The Heartbeat cron (generatePicks) just reads from ig_reels (already populated)
3. OR: the scrape happens inside generatePicksHandler itself (since it's called by a Manus agent that HAS the IG connector)

Actually the simplest: the generatePicks handler is called by a scheduled Manus agent. That agent also has the IG MCP. So the agent can:
1. Call get_post_list + get_post_insights via MCP
2. POST the results to /api/scheduled/scrapeReels 
3. Then call /api/scheduled/generatePicks

This keeps the server code pure Node (no MCP dependency).
