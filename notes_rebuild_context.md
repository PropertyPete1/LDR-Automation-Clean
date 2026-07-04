# Full Rebuild Context (Jul 4 2026)

## USER DIRECTIVE (FINAL)
1. Scrape IG for reels with views, engagement, description (for RANKING only)
2. AI picks the best engagement reel not posted in 30 days
3. AI VISION finds the matching Drive original (NO IDs, NO filename matching — purely visual)
4. Download from Drive → variant → post the original
5. Caption comes from the IG description (with slight AI hook refresh)
6. 30-day dedup is VISUAL ONLY (AI compares thumbnails)
7. Remove ALL ID-based matching from the system
8. Old data is WIPED (videos, reposts, daily_picks, ig_post_history all empty)
9. Today's queue is cleared — nothing posts today

## WHAT EXISTS NOW
- `ig_reels` table: EMPTY (schema created, ready for scrape data)
- `post_history` table: EMPTY (schema created, for 30-day visual dedup)
- `drive_videos` table: 411 files indexed, 124 with Google thumbnails (growing daily)
- `videos` table: EMPTY (wiped, still referenced by old code)
- `reposts` table: EMPTY (wiped, still referenced by old code)
- `daily_picks` table: EMPTY (wiped)
- `ig_post_history` table: EMPTY (wiped)

## KEY FILES TO REWRITE

### server/selection.ts — REWRITE
- Currently: picks from old `Video[]` by views, uses postId-based cooldown
- New: pick from `ig_reels` by engagementScore, visual-only 30-day dedup
- KEEP: getCdtPickDate, cdtTimeToUtcMs, defaultScheduleMs, isDallasDay, scheduleHourFor

### server/routers.ts ensureTodayPicks — REWRITE
- Currently: loads old videos library, uses caption+visual dedup, inserts with videoId/postId
- New: loads ig_reels by city, ranks by engagement, visual dedup against post_history, inserts pick

### server/db.ts — ADD NEW HELPERS
- Keep: getDailyPicks, getDailyPick, insertDailyPick, updateDailyPick, getDueConfirmedPickForCity, getConfirmedDuePicks, markRepostPosted, markRepostFailed, insertRepost, getAllReposts, getRepostById
- Rewrite: autoConfirmPick (remove dependency on old videos table)
- Remove: getLastRepostByPostId (postId-based cooldown)
- Add: getReelsByCity, getRecentPostHistory, insertPostHistory

### server/drivePreprocess.ts — REWRITE
- Currently: uses gws CLI for download, references old video library (db.getVideoById)
- New: uses fetch() for download (Google Drive API), references ig_reels for thumbnail/caption
- Keep: same overall flow (match → download → variant → upload → store key)

### server/driveIndex.ts — REWRITE
- Currently: uses gws CLI (sandbox-only)
- New: uses Google Drive REST API via fetch() with GOOGLE_WORKSPACE_CLI_TOKEN
- Keep: same DB upsert logic, same folder ID, same fields

### server/sourceCooldown.ts — REMOVE OR REWRITE
- Currently: blocks publish by postId or caption fingerprint
- New: REMOVE entirely (visual dedup happens at selection time, not publish time)
- The publish path should just publish what's been picked (trust the morning selection)

### server/igHistorySync.ts — KEEP isVisuallyDuplicate, REMOVE the rest
- isVisuallyDuplicate: reusable AI vision dedup function
- Remove: syncIgPostHistory, captionFingerprint, isCaptionRecentlyPosted, getRecentIgHistory

### server/scheduledPublish.ts — MINOR UPDATES
- publishNow: remove sourceCooldown guard (GUARD 1), remove legacy variant path
- dueForPublish: update to work with ig_reels instead of old videos table
- generatePicksHandler: already calls drivePreprocess, just needs new ensureTodayPicks

## KEY INTERFACES

### igScraper.ts (ALREADY WRITTEN)
- `upsertScrapedReels(reels: ScrapedReel[])` — stores IG data with engagement scores
- `getReelsByCity(city)` — returns reels sorted by engagement
- `getAllReels()` — all reels
- `computeEngagementScore(reel)` — views + likes*10 + comments*20 + shares*30 + saved*15

### driveMatcher.ts (KEEP AS-IS)
- `findDriveMatch({ igThumbnailUrl, igCaption, igDurationMs })` → MatchResult | null
- Uses AI vision (gemini-3-flash-preview) to compare thumbnails
- Returns { matchedFileId, fileName, confidence: "high"|"medium" }

### videoVariant.ts (KEEP AS-IS)
- `makeDifferentiatedVariant({ sourceUrl, postId, salt, sourceBytes? })` → VariantResult
- Returns { ok, url, storageKey, error }

### hookOptimizer.ts (KEEP AS-IS)
- `optimizeHook(caption, brandLabel?)` → { caption, changed, reason }

### captionRefresh.ts (KEEP AS-IS)
- `refreshCaption(caption)` → refreshed caption string

### geoClassify.ts (KEEP AS-IS)
- `classifyMarket(caption, onscreen?, thumbnailUrl?)` → "austin"|"san_antonio"|"dallas"

### storage.ts (KEEP AS-IS)
- `storagePut(relKey, data, contentType)` → { key, url }
- `storageGetSignedUrl(relKey)` → signed URL string

## NEW MORNING PIPELINE FLOW
1. Sync Drive index (refresh thumbnails) — via Google Drive API fetch()
2. Load ig_reels by city, ranked by engagementScore DESC
3. For each city (SA, Austin, Dallas on Dallas days):
   a. Iterate candidates by engagement score
   b. Get candidate's hosted thumbnail (thumbnailStorageKey → signed URL)
   c. Load post_history last 30 days (thumbnailStorageKey → signed URLs)
   d. AI vision: is candidate visually similar to any recent post? (isVisuallyDuplicate)
   e. If duplicate → skip, try next candidate
   f. If fresh → pick it
4. For each picked reel:
   a. refreshCaption → optimizeHook → store as refreshedCaption
   b. AI vision match thumbnail against Drive video thumbnails (findDriveMatch)
   c. Download matched Drive original via fetch() (Google Drive API)
   d. Apply variant fingerprint (makeDifferentiatedVariant with sourceBytes)
   e. Upload to S3, store storage key on pick
5. Auto-confirm picks
6. At 2/3/4 PM: publishNow generates fresh signed URL from key → posts via Metricool

## PRODUCTION RUNTIME CONSTRAINTS
- Node.js only (no Python, no gws CLI, no rclone)
- Google Drive API via fetch() with GOOGLE_WORKSPACE_CLI_TOKEN env var
- Token: Bearer token for Google Drive REST API
- Download URL: `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`
- List URL: `https://www.googleapis.com/drive/v3/files?q=...&fields=...`

## IG MCP TOOLS (sandbox/agent only, NOT production)
- `get_post_list` (server: instagram): posts with ID, type, caption, likes, comments, link, date
- `get_post_insights` (server: instagram): views, reach, shares, saved for a post ID
- The IG scrape runs as a scheduled Manus agent task (has MCP), stores results in ig_reels DB
- The Heartbeat cron (production) reads from ig_reels table (already populated)

## DAILY_PICKS SCHEMA (what we insert)
- pickDate, city, videoId (ig_reels.id), postId (ig_reels.igMediaId — internal only)
- refreshedCaption, selectionMode, scheduledFor, status
- driveVideoUrl (storage key), driveMatchConfidence

## AUTOCONFIRM REWRITE
- Old: reads from videos table for caption/views/thumbnail
- New: reads from ig_reels table for caption/views/thumbnail
- Still creates repost row + flips pick to confirmed
