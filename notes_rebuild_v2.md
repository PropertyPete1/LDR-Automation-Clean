# Rebuild V2 — Drive-Only Pipeline (Complete Context)

## USER DIRECTIVE (CRITICAL)
- NO video IDs for matching. EVER. Pure AI vision only.
- Scrape IG for engagement data (views, likes, comments, shares, saved)
- Pick the best performing reels that haven't posted in 30 days
- AI vision matches the IG reel thumbnail to the Drive original
- Download from Drive, variant, post the Drive original
- Use the IG description (with slight AI hook refresh)
- Old data is WIPED. Clean slate.

## CURRENT STATE
- `videos` table: EMPTY (wiped)
- `reposts` table: EMPTY (wiped)  
- `daily_picks` table: EMPTY (wiped)
- `ig_post_history` table: EMPTY (wiped)
- `drive_videos` table: 411 indexed files, 124 with thumbnails (growing daily)
- `ig_reels` table: EXISTS but empty (new table, needs population)
- `post_history` table: EXISTS but empty (new table, tracks what we posted)

## NEW FLOW (morning 8 AM CT)
1. Agent scrapes IG via MCP → POSTs results to `/api/scheduled/scrapeReels`
2. Agent calls `/api/scheduled/generatePicks`
3. generatePicks:
   a. Reads ig_reels (already populated by step 1)
   b. For each city: picks highest engagement reel not in post_history last 30 days
   c. AI vision dedup: compare candidate thumbnail vs post_history thumbnails
   d. refreshCaption + optimizeHook on the IG caption
   e. Insert daily_pick (videoId = ig_reels.id, postId = ig_reels.igMediaId)
   f. Auto-confirm
   g. Drive preprocessing: AI vision match → download → variant → upload to S3

## PUBLISH FLOW (2/3/4 PM CT)
1. Heartbeat cron calls `/api/scheduled/publishNow`
2. publishNow reads pick.driveVideoUrl (S3 storage key)
3. Generates fresh signed URL from storage key
4. Publishes via Metricool

## FILES TO REWRITE

### 1. server/igScraper.ts — FIX ordering (add desc import)
- `getReelsByCity` needs `desc(igReels.engagementScore)` not just `igReels.engagementScore`
- Add `import { desc } from "drizzle-orm"` 

### 2. server/driveIndex.ts — REPLACE gws CLI with Google Drive API fetch()
- Token: `process.env.GOOGLE_WORKSPACE_CLI_TOKEN || process.env.GOOGLE_DRIVE_TOKEN`
- List: `https://www.googleapis.com/drive/v3/files?q='FOLDER_ID'+in+parents&fields=...&pageSize=100`
- Download: `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`
- FOLDER_ID: `16mNnK1avek0LUljjFPZ5iNxON2OJZod7`

### 3. server/drivePreprocess.ts — Use ig_reels instead of old videos table
- Replace `db.getVideoById(pick.videoId)` with reading from ig_reels
- Get thumbnail from `storageGetSignedUrl(reel.thumbnailStorageKey)` for AI vision
- Download via fetch() to Drive API (not gws CLI)

### 4. server/db.ts — ADD new helpers
- `getReelById(id: number)` — select from igReels where id = ?
- `getRecentPostHistory(days: number)` — select from postHistory where postedAt > cutoff
- `insertPostHistory(row)` — insert into postHistory
- CHANGE `autoConfirmPick`: use igReels instead of videos table for thumbnailUrl/views

### 5. server/routers.ts — REWRITE ensureTodayPicks
- Replace `db.getVideosByCity(city)` with `getReelsByCity(city)` from igScraper
- Replace `selectForCity` with simple engagement-ranked selection from ig_reels
- Replace caption-fingerprint dedup with AI vision dedup against post_history
- Keep refreshCaption + optimizeHook unchanged
- Replace `db.getVideoById` calls with `getReelById`

### 6. server/scheduledPublish.ts — CLEANUP
- REMOVE: import of `checkSourceCooldown` and GUARD 1 (lines 184-210)
- REMOVE: import of `syncIgPostHistory`
- REMOVE: legacy variant path in GUARD 2 — only Drive originals now
- UPDATE: `dueForPublishHandler` — replace `db.getVideoById(pick.videoId)` with `getReelById`
- UPDATE: `publishNowHandler` — replace `db.getVideoById(pick.videoId)` with `getReelById`
- ADD: after successful publish, insert into post_history

### 7. server/_core/index.ts — ADD new endpoint
- Import and register `scrapeReelsHandler` at `/api/scheduled/scrapeReels`

### 8. DELETE/DEPRECATE
- server/sourceCooldown.ts — no longer needed
- server/igHistorySync.ts — keep ONLY `isVisuallyDuplicate` function, adapt interface

## KEY FUNCTION SIGNATURES
```
refreshCaption(caption: string): Promise<string>
optimizeHook(caption: string, brandLabel?: string): Promise<{ caption: string; changed: boolean; reason?: string }>
classifyMarket(caption?: string | null, onscreen?: string | null, thumbnailUrl?: string | null): Promise<Market>
findDriveMatch({ igThumbnailUrl, igCaption, igDurationMs }): Promise<MatchResult | null>
  MatchResult: { matchedFileId: string; fileName: string; confidence: "high"|"medium" }
makeDifferentiatedVariant({ sourceUrl, postId, salt, sourceBytes? }): Promise<{ ok, url, storageKey, sha256, error }>
storagePut(relKey, data, contentType): Promise<{ key, url }>
storageGetSignedUrl(relKey): Promise<string>  // returns full signed URL
computeEngagementScore(reel): number  // views + likes*10 + comments*20 + shares*30 + saved*15
upsertScrapedReels(reels: ScrapedReel[]): Promise<{ upserted: number }>
```

## VISUAL DEDUP (adapted from igHistorySync.isVisuallyDuplicate)
- Input: candidateThumbnailUrl (signed URL from S3), recentPosts (post_history rows)
- Convert post_history thumbnailStorageKeys to signed URLs before passing to LLM
- Uses gemini vision to compare thumbnails
- Returns boolean: true = duplicate (skip), false = fresh (safe to pick)
- Prompt: same property/development/location = duplicate

## DAILY_PICKS SCHEMA (existing, no changes needed)
- id, pickDate, city, videoId (now = ig_reels.id), postId (now = ig_reels.igMediaId)
- refreshedCaption, selectionMode, scheduledFor, status, repostId
- driveVideoUrl (S3 storage key), driveMatchConfidence

## SCRAPE ENDPOINT CONTRACT
POST /api/scheduled/scrapeReels
Body: { reels: ScrapedReel[] }
- ScrapedReel: { igMediaId, caption, views, likes, comments, shares, saved, reelLink, postedAt, thumbnailUrl? }
- Calls upsertScrapedReels internally
- Returns { ok: true, upserted: number }
