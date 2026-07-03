# Drive-Original Matching — Implementation Design

## Architecture

### Current flow (being replaced):
1. Selection engine picks best IG reel (high views, 30-day cooldown, caption dedup, AI visual dedup)
2. Posting agent fetches the video .mp4 from Instagram CDN
3. videoVariant.ts appends random `free` MP4 boxes to change hash
4. Uploads to Metricool → posts to all brands

### New flow:
1. Selection engine picks best IG reel (SAME as before — no change)
2. **NEW: AI vision matches the selected reel to its original in Google Drive**
3. **NEW: Downloads the original from Drive (via gws CLI / rclone)**
4. videoVariant.ts appends random `free` MP4 boxes (already exists)
5. Uploads to Metricool → posts to all brands

### Key insight: The Drive original IS already different from the IG copy
- Instagram re-encodes all uploads (different codec settings, bitrate, container)
- The Drive file was never uploaded to IG in that exact form
- So posting the Drive original + hash change = IG sees it as genuinely new content
- No heavy ffmpeg transforms needed for MVP

## AI Vision Matching Strategy

### Inputs:
- The selected IG reel's thumbnail URL (stored in our `videos` table as `thumbnailUrl`)
- The selected IG reel's caption (stored in our `videos` table as `caption`)
- List of Drive videos with their Google-generated thumbnails (23/42 have them)

### Matching approach (multi-signal):
1. **Duration matching (fast filter):** IG reel duration vs Drive video duration (from videoMediaMetadata.durationMillis). Narrow candidates to ±3 seconds.
2. **Thumbnail visual comparison (AI vision):** Send IG thumbnail + top candidate Drive thumbnails to LLM vision. Ask: "Which of these Drive video thumbnails shows the same video/property as the IG reel?"
3. **Caption-to-filename hint:** Some Drive filenames may contain recognizable patterns. Low confidence but free.

### For videos without Drive thumbnails (19/42):
- Option A: Skip them in matching (they'll get thumbnails once Google processes them)
- Option B: Download first 2MB of the file, extract a frame with ffmpeg in sandbox (not in deployed app)
- **Decision:** Use Option A for now. As more videos upload and Google processes them, coverage grows. The morning generation job runs in the sandbox where we CAN use ffmpeg if needed later.

### Matching confidence:
- Duration match + visual match = high confidence → proceed
- Visual match only (no duration data) = medium confidence → proceed with warning
- No match found = skip this pick, try next candidate in the selection queue

## Google Drive Access

### Folder:
- Name: "Camera Roll Real Estate Videos"  
- ID: `16mNnK1avek0LUljjFPZ5iNxON2OJZod7`
- 42 videos (36 mp4, 6 mov), sizes 23-130MB
- Still growing (user automation adds new videos)

### API access:
- `gws drive files list` — list files with thumbnailLink, videoMediaMetadata
- `gws drive files get` — get file metadata
- `rclone copy manus_google_drive:path/to/file ./local/ --config /home/ubuntu/.gdrive-rclone.ini` — download file

### Download approach:
- Use rclone for downloading the matched video (handles large files, auth pre-configured)
- Download to /tmp/ in the sandbox, then upload to Metricool via uploadVideoToMetricool()

## Integration Points

### Where to hook in:
The posting agent calls `POST /api/scheduled/publishNow` with `{pickId, repostId, videoUrl, thumbnailUrl}`.
Currently `videoUrl` is the IG CDN URL. The agent fetches this from Instagram.

**Change:** Instead of the agent fetching from IG, the server-side `publishNowHandler` will:
1. Take the pick's video info (thumbnail, caption, duration)
2. Call the Drive matcher to find the original
3. Download from Drive
4. Apply videoVariant
5. Upload to Metricool and post

This means the agent no longer needs to fetch the video URL from Instagram at all.
The agent just calls dueForPublish → gets the pick → calls publishNow (without videoUrl).
publishNow handles everything server-side.

### BUT: Server is serverless (180s timeout, 512MB RAM)
- Downloading a 100MB video from Drive + uploading to Metricool may exceed 180s
- The matching (LLM vision call) adds ~10-20s
- Total could be 60-120s for a typical video — tight but possible for most files

### Alternative: Pre-process in the morning generation job
- Morning job (8 AM CT) already generates picks
- After generating, it could also:
  1. Match each pick to its Drive original
  2. Download the original
  3. Apply variant
  4. Upload to our S3 storage (storagePut)
  5. Store the storage URL on the pick row
- Then at 2 PM, publishNow just grabs the pre-uploaded URL — fast and simple

**Decision:** Pre-process in morning job. This gives plenty of time (no 180s constraint since Heartbeat jobs can take longer) and the 2 PM publish is instant.

## Drive Video Index (for efficient matching)

Build a `drive_videos` table:
- driveFileId (text, PK)
- fileName (text)
- mimeType (text)
- sizeBytes (int)
- durationMs (int, nullable — from videoMediaMetadata)
- width (int, nullable)
- height (int, nullable)
- thumbnailUrl (text, nullable — Google's thumbnailLink)
- hostedThumbnailUrl (text, nullable — our storage copy for reliable access)
- createdAt (bigint)
- lastIndexedAt (bigint)

Sync this index periodically (morning job) so we always know what's available.

## LLM Model Choice for Vision Matching
- Use `gemini-3-flash-preview` — cheap ($0.50/1M in), multimodal, fast
- Send IG thumbnail + up to 5 Drive thumbnails per call
- Batch in groups of 5 if many candidates after duration filter
- Structured JSON output: {matchedFileId: string | null, confidence: "high"|"medium"|"low"}

## Files to create/modify:
1. `drizzle/schema.ts` — add drive_videos table
2. `server/driveIndex.ts` — sync Drive folder → drive_videos table
3. `server/driveMatcher.ts` — AI vision matching (IG thumbnail vs Drive thumbnails)
4. `server/scheduledPublish.ts` — modify publishNowHandler to use Drive original
5. `server/linkedinScheduled.ts` or morning job — pre-process matching + download
6. Remove: the agent's video URL fetch step (dead code)
