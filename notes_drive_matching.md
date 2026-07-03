# Drive-Original Matching — Architecture Notes

## Google Drive Folder
- Name: "Camera Roll Real Estate Videos"
- ID: 16mNnK1avek0LUljjFPZ5iNxON2OJZod7
- Files: 42 videos (36 mp4, 6 mov) + 1 txt
- Still uploading (user said 50+ coming)
- Sizes: 23MB to 130MB
- Resolutions: 1080x1920 (standard) to 2160x3840 (true 4K)

## Thumbnails from Drive
- 23/42 files have thumbnailLink (Google-generated thumbnail)
- 19/42 don't have thumbnails yet (still processing or recently uploaded)
- Thumbnails are lh3.googleusercontent.com URLs (accessible with auth)

## Matching Strategy
The IG reel has a thumbnail (stored in our ig_post_history / videos table).
Drive videos have Google-generated thumbnails (23/42 available).

**Plan:**
1. When a pick is selected (we know the IG postId + thumbnail), extract a frame from the IG reel
2. For Drive videos: use the thumbnailLink where available, or extract a frame by downloading the first few seconds
3. Use LLM vision to compare the IG frame against Drive thumbnails (batch comparison)
4. Match confidence: template overlays, text content, scene composition, branding

**Challenge:** 19 videos don't have Drive thumbnails yet. For those, we'd need to download a portion to extract a frame — expensive for 100MB+ MOV files.

**Better approach:** Build a Drive video index that pre-caches thumbnails. For videos without Google thumbnails, download just the first 2 seconds (or use rclone partial download) to extract a frame. Store these in our DB/storage. This index builds over time as videos are uploaded.

## Video Processing (transformations)
Need ffmpeg for:
- Tiny invisible watermark (first 3 sec)
- Different trim/cut
- Re-encode at different bitrate

**Constraint:** Deployed web app is serverless (180s timeout, 512MB RAM, no ffmpeg).
**Solution:** Do video processing during the MORNING generation job (not at post time).
The morning job runs as a Heartbeat hitting our server — same 180s constraint.

**Alternative:** Use the sandbox/persistent compute for heavy processing, OR keep transformations lightweight enough for serverless:
- The existing videoVariant.ts already appends random `free` MP4 boxes to change the hash (pure Node, no ffmpeg)
- Adding a tiny watermark to the first 3 sec requires actual frame manipulation → needs ffmpeg
- Different trim requires ffmpeg

**Decision needed:** Can we install ffmpeg in the deployed container? Check template capabilities.
If not, the "append random bytes" approach already changes the file fingerprint. Combined with the fact that we're posting the ORIGINAL (not the IG copy), IG may not flag it at all since it's a genuinely different file.

## Revised simpler approach
Since the whole point is that IG flags COPIES (same file hash), posting the ORIGINAL from Drive is already a different file with different encoding. The original was never uploaded to IG in that exact form (IG re-encodes on upload). So:
- The Drive original IS already "transformed" relative to what IG has on file
- We may not need heavy ffmpeg transforms at all
- The existing videoVariant (append free boxes) adds extra fingerprint safety
- The tiny watermark is bonus insurance but may not be necessary

Start with: Drive original + existing videoVariant (hash change). If views are still low after testing, THEN add ffmpeg transforms.
