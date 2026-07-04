# REWRITE PLAN — Drive-Only Pipeline (FINAL)

## User Directive (CRITICAL)
1. Scrape IG for reels → get views, engagement, description
2. AI picks the best → highest engagement, NOT posted in last 30 days
3. AI VISION finds the matching Drive original → compares thumbnails visually, NO IDs
4. Download from Drive → post the original with the IG description (slightly refreshed hook)
5. Remove ALL old data, remove ALL ID-based matching
6. Pure AI intelligence for matching

## Current State
- Old `videos` table: WIPED (0 rows)
- Old `reposts` table: WIPED (0 rows)  
- Old `ig_post_history` table: WIPED (0 rows)
- Old `daily_picks` table: WIPED (0 rows)
- New `ig_reels` table: EXISTS but empty (needs scrape)
- New `post_history` table: EXISTS but empty
- `drive_videos` table: 411 rows indexed (124 with thumbnails, rest loading)

## Architecture

### Tables Used
- `ig_reels`: scraped IG reels ranked by engagement (populated by agent via MCP)
- `post_history`: what WE posted (for 30-day AI vision dedup) - thumbnailStorageKey, caption, city, postedAt
- `daily_picks`: today's picks (still uses videoId/postId fields - repurpose: videoId=igReels.id, postId=igReels.igMediaId)
- `drive_videos`: Drive folder index (411 files, thumbnailUrl from Google)
- `reposts`: still used by publishNow for tracking

### Flow
1. **Agent scrapes IG** → calls `/api/scheduled/scrapeReels` with MCP data → upserts into `ig_reels`
2. **Morning cron (8AM CT)** → `ensureTodayPicks`:
   - Get reels by city from `ig_reels` (sorted by engagementScore DESC)
   - For each candidate, AI vision dedup against `post_history` (last 30 days)
   - Pick the first one that passes dedup
   - Refresh caption (slight hook variation)
   - Insert into `daily_picks`
   - Auto-confirm
3. **Drive preprocessing** (after picks confirmed):
   - Sync Drive index (fetch API, not gws CLI)
   - For each pick: get its hosted thumbnail from ig_reels.thumbnailStorageKey
   - AI vision match against Drive video thumbnails
   - Download from Drive (fetch API with GOOGLE_WORKSPACE_CLI_TOKEN)
   - Apply variant fingerprint
   - Upload to S3, store storageKey on pick
4. **Publish (2/3/4 PM CT)** → `publishNow`:
   - Get pick's driveVideoUrl (storage key)
   - Generate fresh signed URL
   - Post via Metricool

### Key Function Signatures
- `storagePut(key, buffer, contentType)` → `{ key, url }`
- `storageGetSignedUrl(key)` → signed URL string
- `classifyMarket(caption)` → "austin" | "san_antonio" | "dallas" | null
- `refreshCaption(caption)` → refreshed caption string
- `optimizeHook(caption)` → `{ caption, changed, reason }`
- `makeDifferentiatedVariant({ sourceUrl, postId, salt, sourceBytes? })` → `{ ok, url, storageKey, error }`
- `findDriveMatch({ igThumbnailUrl, igCaption, igDurationMs })` → `{ matchedFileId, fileName, confidence }` | null
- `invokeLLM({ messages, response_format?, max_tokens? })` → OpenAI-style response

### Files to Rewrite
1. **selection.ts** — remove `selectForCity` (uses old Video type), keep utility functions (getCdtPickDate, defaultScheduleMs, isDallasDay, etc.)
2. **driveIndex.ts** — replace gws CLI with Google Drive REST API via fetch() using GOOGLE_WORKSPACE_CLI_TOKEN
3. **drivePreprocess.ts** — use ig_reels instead of old videos table; download via fetch API
4. **driveMatcher.ts** — fix max_tokens from 256 to 2048
5. **routers.ts ensureTodayPicks** — pick from ig_reels, AI vision dedup against post_history
6. **db.ts** — add new helpers for ig_reels and post_history; keep existing helpers that still work
7. **scheduledPublish.ts** — remove sourceCooldown import; add scrapeReels endpoint; update dueForPublish to use ig_reels
8. **_core/index.ts** — register new scrapeReels endpoint

### Drive API Token
- Env var: `GOOGLE_WORKSPACE_CLI_TOKEN` (available in sandbox)
- In production: `GOOGLE_DRIVE_TOKEN` (set via webdev_request_secrets)
- Token getter: `process.env.GOOGLE_DRIVE_TOKEN || process.env.GOOGLE_WORKSPACE_CLI_TOKEN`
- Drive folder ID: `16mNnK1avek0LUljjFPZ5iNxON2OJZod7`
- API base: `https://www.googleapis.com/drive/v3`
- List: `GET /files?q='FOLDER_ID'+in+parents&fields=...&pageSize=100`
- Download: `GET /files/{fileId}?alt=media` with `Authorization: Bearer TOKEN`

### isVisuallyDuplicate Reuse
The existing `isVisuallyDuplicate` in igHistorySync.ts compares candidate thumbnail against recent post thumbnails using AI vision. For the new system, we need to compare against `post_history` thumbnails (which are hosted on S3 via thumbnailStorageKey). We'll create a new version that reads from post_history and generates signed URLs for the thumbnails.

### IG Scraper MCP Tools
- `get_post_list`: returns posts with id, caption, like_count, comments_count, permalink, timestamp
- `get_post_insights`: returns views, reach, shares, saved for a specific post
- Pagination: after/before cursors
- MCP only works in agent context (NOT in production heartbeat cron)
- Solution: agent scrapes → stores in ig_reels → heartbeat reads from ig_reels
