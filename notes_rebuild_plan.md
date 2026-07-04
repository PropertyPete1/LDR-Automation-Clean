# Drive-Only Pipeline Rebuild Plan (Jul 4 2026)

## User Directive (FINAL, no more changes)
1. Scrape IG for reels with views, engagement, description (for RANKING only)
2. AI picks the best engagement reel not posted in 30 days
3. AI VISION finds the matching Drive original (NO IDs, NO filename matching — purely visual)
4. Download from Drive → variant → post the original
5. Caption comes from the IG description (with slight AI hook refresh)
6. 30-day dedup is VISUAL ONLY (AI compares thumbnails)
7. Remove ALL ID-based matching from the system

## IG MCP Tools Available
- `get_post_list` (server: instagram): returns posts with ID, type, caption, likes, comments, link, posted date. Max 20 per page, paginated.
- `get_post_insights` (server: instagram): returns views, reach, shares, saved, total_interactions for a post ID
- `create_instagram` (server: instagram): publish a reel with media_url + caption
- `get_account_info` (server: instagram): profile info

## Key Issue: IG MCP doesn't return thumbnail URLs directly
- Posts have a `Link` field (e.g. https://www.instagram.com/reel/DaV_kvZjyx9/)
- Need to extract thumbnail from the reel page, OR use the IG Graph API media endpoint
- Alternative: use the reel link to get og:image meta tag

## Current DB State
- `videos` table: EMPTY (wiped)
- `reposts` table: EMPTY (wiped)
- `daily_picks` table: EMPTY (wiped)
- `ig_post_history` table: EMPTY (wiped)
- `drive_videos` table: 411 files, 124 with Google thumbnails
- Need new table: `ig_reels` for scraped IG data

## New `ig_reels` Table Schema
- id (PK auto)
- igMediaId (varchar 32, unique) — only used internally for dedup during scrape, NOT for matching
- thumbnailUrl (varchar 512) — hosted copy of the reel thumbnail (for AI vision)
- caption (text)
- views (int)
- likes (int)
- comments (int)
- shares (int)
- saved (int)
- engagementScore (int) — computed: views + likes*10 + comments*20 + shares*30 + saved*15
- city (enum: austin, san_antonio, dallas)
- reelLink (varchar 255)
- postedAt (bigint) — when originally posted on IG
- lastScrapedAt (bigint)
- createdAt (timestamp)

## New `post_history` Table (for 30-day visual dedup)
- id (PK auto)
- thumbnailStorageKey (varchar 512) — our hosted thumbnail for AI vision comparison
- caption (text) — for context
- city (enum)
- postedAt (bigint) — when WE posted it via this system
- createdAt (timestamp)

## Morning Pipeline Flow
1. Sync Drive index (refresh thumbnails)
2. Scrape IG reels (paginate, get insights for each)
3. Classify each reel by city (AI vision on thumbnail)
4. Rank by engagement score
5. For each city (SA, Austin, Dallas on Dallas days):
   a. Pick highest-engagement reel not visually posted in 30 days
   b. 30-day check: AI vision compares candidate thumbnail vs all post_history thumbnails from last 30 days
   c. If duplicate found, skip and try next candidate
6. For each picked reel:
   a. AI vision match its thumbnail against Drive video thumbnails
   b. Download matched Drive original
   c. Apply variant fingerprint
   d. Upload to S3, store key on pick
7. At 2/3/4 PM: publishNow generates fresh signed URL from key → posts via Metricool

## Files to Create/Rewrite
- server/igScraper.ts — NEW: scrape IG via MCP, store in ig_reels
- server/selection.ts — REWRITE: pick from ig_reels by engagement, visual dedup
- server/drivePreprocess.ts — REWRITE: no more videoId/postId references
- server/routers.ts ensureTodayPicks — REWRITE: use new selection engine
- drizzle/schema.ts — ADD ig_reels table, ADD post_history table
- server/db.ts — ADD helpers for ig_reels and post_history

## Files to Keep (mostly unchanged)
- server/driveMatcher.ts — KEEP: already pure AI vision (just needs different input)
- server/driveIndex.ts — KEEP: syncs Drive folder metadata
- server/videoVariant.ts — KEEP: byte differentiation
- server/captionRefresh.ts — KEEP: slight caption variation
- server/hookOptimizer.ts — KEEP: AI hook optimization
- server/scheduledPublish.ts publishNow — KEEP (already fixed to use storage key)
- server/metricool.ts — KEEP: posts to Metricool

## CRITICAL: No IDs in matching
- The ig_reels table has igMediaId ONLY for internal scrape dedup (don't re-scrape same post)
- Selection and matching NEVER use igMediaId for anything else
- Drive matching is PURELY visual (thumbnail comparison)
- 30-day dedup is PURELY visual (thumbnail comparison)
- No postId, no videoId, no filename extraction

## Download from Drive in Production
- Current drivePreprocess uses `gws` CLI which is sandbox-only
- Need to use Google Drive API via fetch() with GOOGLE_WORKSPACE_CLI_TOKEN
- Token is available as env var in production
- Download URL: `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`
- Auth header: `Authorization: Bearer ${token}`
