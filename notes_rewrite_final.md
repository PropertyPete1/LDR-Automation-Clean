# REWRITE PLAN — Drive-Only Pipeline (Final)

## Architecture
1. **ig_reels table** = scraped IG reels with engagement data (populated by scheduled agent task with IG MCP)
2. **post_history table** = what we've actually posted (for 30-day AI vision dedup)
3. **drive_videos table** = indexed Drive folder metadata (thumbnails for AI matching)
4. **daily_picks table** = daily selection state (reuse existing, but videoId now references ig_reels.id)

## Flow
Morning 8AM CT cron (`generatePicksHandler`):
1. Read ig_reels ranked by engagementScore DESC per city
2. For each city: pick the best reel that is NOT visually similar to anything in post_history (last 30 days)
3. AI vision match the picked reel's thumbnail against Drive video thumbnails → find the original
4. Download Drive original → apply variant → upload to S3 → store storageKey on pick
5. Auto-confirm pick

Publish 2/3/4 PM CT cron (`publishNowHandler`):
1. Get the confirmed pick for this city
2. Generate fresh signed URL from storageKey
3. Post to Metricool with the caption from the pick

## Key Changes to Each File

### selection.ts
- Keep: getCdtPickDate, cdtTimeToUtcMs, scheduleHourFor, defaultScheduleMs, isDallasDay
- REPLACE: selectForCity → new function that picks from ig_reels by engagementScore, checks post_history visually

### db.ts
- Keep: users, settings, metrics, linkedin, dailyPicks helpers, getDb
- ADD: getReelsByCity(city) → from igReels, ordered by engagementScore DESC
- ADD: getReelById(id) → from igReels
- ADD: getRecentPostHistory(days=30) → from postHistory, last 30 days
- ADD: insertPostHistory(row) → into postHistory
- MODIFY: autoConfirmPick → no longer references old videos table; uses igReels for caption/thumbnail
- REMOVE: getVideosByCity, getAllVideos, getVideoById, bulkInsertVideos, countVideos (old videos table)
- KEEP: reposts helpers (for backward compat with dashboard history view, but not used for dedup)

### routers.ts (ensureTodayPicks)
- Replace old flow with:
  1. Get ig_reels for city (by engagementScore DESC)
  2. Get post_history last 30 days
  3. For each candidate reel: AI vision compare reel.thumbnailStorageKey vs post_history thumbnails
  4. Pick the first one that passes
  5. refreshCaption + optimizeHook
  6. insertDailyPick (videoId = igReel.id, postId = igReel.igMediaId)
  7. autoConfirmPick

### drivePreprocess.ts
- MODIFY preprocessPick: instead of db.getVideoById(pick.videoId), use db.getReelById(pick.videoId) to get thumbnailStorageKey
- Convert thumbnailStorageKey to signed URL for the AI matcher
- Remove gws CLI download → use Google Drive API via fetch (already done in driveIndex.ts)

### driveIndex.ts
- REWRITE listDriveVideos: use Google Drive REST API via fetch() with GOOGLE_WORKSPACE_CLI_TOKEN
- Keep syncDriveIndex, getAllDriveVideos, getDriveVideosByDuration

### driveMatcher.ts
- FIX: max_tokens 256 → 2048 (Gemini reasoning tokens)
- Interface stays the same: findDriveMatch({ igThumbnailUrl, igCaption?, igDurationMs? })

### scheduledPublish.ts
- dueForPublishHandler: replace db.getVideoById(pick.videoId) with db.getReelById(pick.videoId)
- publishNowHandler: 
  - Remove sourceCooldown check (replaced by AI vision dedup at pick time)
  - Remove legacy variant path (Drive originals are already varianted)
  - Remove bodyVideoUrl fallback (Drive-only)
  - After successful publish: insert into post_history (thumbnailStorageKey + caption + city + postedAt)
- generatePicksHandler: keep as-is (calls ensureTodayPicks + preprocessDriveOriginals)
- REMOVE: syncIgHistoryHandler (old ig_post_history sync)

### sourceCooldown.ts
- DELETE entirely (replaced by AI vision dedup at pick time)

### igHistorySync.ts
- KEEP: isVisuallyDuplicate function (reuse for post_history dedup)
- REMOVE: syncIgPostHistory, getRecentIgHistory, isCaptionRecentlyPosted (old ig_post_history)

### igScraper.ts
- FIX: getReelsByCity ordering → add desc(igReels.engagementScore)
- FIX: getAllReels → add orderBy desc
- Keep upsertScrapedReels (called by scheduled agent task)
- ADD: scrapeReelsHandler endpoint for the agent to call

## Schema Notes
- daily_picks.videoId will now reference ig_reels.id (not videos.id)
- daily_picks.postId will now be ig_reels.igMediaId
- daily_picks.driveVideoUrl stores S3 storage KEY (not signed URL)
- post_history.thumbnailStorageKey = same as ig_reels.thumbnailStorageKey for the posted reel

## Token for Drive API
- Use process.env.GOOGLE_DRIVE_TOKEN || process.env.GOOGLE_WORKSPACE_CLI_TOKEN
- Direct fetch to https://www.googleapis.com/drive/v3/files
- Download: https://www.googleapis.com/drive/v3/files/{fileId}?alt=media

## Endpoints to register in _core/index.ts
- ADD: app.post("/api/scheduled/scrapeReels", scrapeReelsHandler)
- REMOVE: syncIgHistoryHandler reference (or keep for backward compat but make it no-op)
