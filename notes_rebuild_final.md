# Final Rebuild Context — Drive-Only Pipeline

## WHAT TO DO NOW

### 1. Rewrite `server/selection.ts`
- KEEP: getCdtPickDate, cdtTimeToUtcMs, defaultScheduleMs, isDallasDay, scheduleHourFor, Market type
- REMOVE: selectForCity (uses old Video type + postId-based cooldown)
- ADD: `selectFromReels(reels: IgReel[], postHistory: PostHistory[], excludeIds: Set<number>)` 
  - Ranks by engagementScore DESC
  - Skips any reel whose thumbnail is visually similar to post_history (last 30 days)
  - Returns the best non-duplicate reel

### 2. Rewrite `server/routers.ts` ensureTodayPicks
- REMOVE: all references to old `videos` table, `getVideosByCity`, `getLastRepostByPostId`, `isCaptionRecentlyPosted`, `isVisuallyDuplicate` from igHistorySync
- NEW FLOW:
  1. Load ig_reels by city (from igScraper.getReelsByCity)
  2. Load post_history last 30 days
  3. For each city, iterate reels by engagement score
  4. AI vision dedup: compare reel thumbnail vs post_history thumbnails
  5. Pick first non-duplicate
  6. refreshCaption → optimizeHook → insertDailyPick
  7. Auto-confirm
  8. Drive preprocessing (match → download → variant → upload)

### 3. Rewrite `server/db.ts` autoConfirmPick
- OLD: reads from `videos` table (getVideoById) for caption/views/thumbnail
- NEW: reads from `igReels` table for caption/views/thumbnail
- Change: `getVideoById(pick.videoId)` → `getReelById(pick.videoId)` (videoId now points to ig_reels.id)

### 4. Add to `server/db.ts`
- `getReelById(id: number)` — select from igReels where id = ?
- `getRecentPostHistory(days: number)` — select from postHistory where postedAt > cutoff
- `insertPostHistory(row)` — insert into postHistory

### 5. Rewrite `server/scheduledPublish.ts`
- REMOVE: import of `checkSourceCooldown` and GUARD 1 (lines 186-210)
- REMOVE: legacy variant path in GUARD 2 (lines 226-243) — only Drive originals now
- UPDATE: `dueForPublishHandler` — replace `db.getVideoById(pick.videoId)` with `getReelById`
- UPDATE: `publishNowHandler` — replace `db.getVideoById(pick.videoId)` with `getReelById`
- ADD: after successful publish, insert into post_history (thumbnail + caption + city + postedAt)

### 6. Rewrite `server/driveIndex.ts`
- Already uses Google Drive REST API via fetch() with token from env
- The gws CLI version is still in the file — REPLACE with fetch() version
- Token: `process.env.GOOGLE_WORKSPACE_CLI_TOKEN || process.env.GOOGLE_DRIVE_TOKEN`
- List URL: `https://www.googleapis.com/drive/v3/files?q=...&fields=...`
- Download URL: `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`

### 7. Rewrite `server/drivePreprocess.ts`
- REMOVE: gws CLI download (execSync)
- REPLACE: download via fetch() to Google Drive API
- UPDATE: `preprocessPick` — replace `db.getVideoById(pick.videoId)` with `getReelById`
- The reel has `thumbnailStorageKey` → generate signed URL for AI vision matching

### 8. Remove `server/sourceCooldown.ts`
- No longer needed — dedup is visual-only at selection time

### 9. Clean up `server/igHistorySync.ts`
- KEEP: `isVisuallyDuplicate` function (reusable AI vision dedup)
- REMOVE: everything else (syncIgPostHistory, captionFingerprint, isCaptionRecentlyPosted, getRecentIgHistory)

## KEY INTERFACES

### igReels table (ig_reels)
- id (PK auto), igMediaId (unique, internal only), thumbnailStorageKey, caption, views, likes, comments, shares, saved, engagementScore, city, reelLink, postedAt, lastScrapedAt

### postHistory table (post_history)  
- id (PK auto), thumbnailStorageKey, caption, city, postedAt

### daily_picks table (existing)
- videoId → now points to ig_reels.id
- postId → now stores ig_reels.igMediaId (internal reference only, NOT used for matching)
- driveVideoUrl → S3 storage key (not signed URL)
- driveMatchConfidence → "high"|"medium"|null

### storageGetSignedUrl(relKey) → full signed URL string
### storagePut(relKey, data, contentType) → { key, url }

### isVisuallyDuplicate(candidateThumbnailUrl, recentPosts, candidateCaption?) → boolean
- recentPosts: Array<{ igPostId: string; thumbnailUrl: string | null; captionSnippet: string | null; postedAt: number }>
- NOTE: Need to adapt this interface for post_history (which has thumbnailStorageKey, not thumbnailUrl)

### findDriveMatch({ igThumbnailUrl, igCaption, igDurationMs }) → MatchResult | null
- MatchResult: { matchedFileId, fileName, confidence: "high"|"medium" }

### makeDifferentiatedVariant({ sourceUrl, postId, salt, sourceBytes? }) → { ok, url, storageKey, error }

### refreshCaption(caption) → string
### optimizeHook(caption, brandLabel?) → { caption, changed, reason }
### classifyMarket(caption, onscreen?, thumbnailUrl?) → "austin"|"san_antonio"|"dallas"

## DRIVE API (for driveIndex.ts and drivePreprocess.ts)
```
const token = process.env.GOOGLE_WORKSPACE_CLI_TOKEN || process.env.GOOGLE_DRIVE_TOKEN;
const headers = { Authorization: `Bearer ${token}` };

// List files
const url = `https://www.googleapis.com/drive/v3/files?q='${FOLDER_ID}'+in+parents&fields=${FIELDS}&pageSize=100`;
const resp = await fetch(url, { headers });

// Download file
const dlUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
const resp = await fetch(dlUrl, { headers });
const buffer = Buffer.from(await resp.arrayBuffer());
```

## FOLDER ID
`16mNnK1avek0LUljjFPZ5iNxON2OJZod7`
