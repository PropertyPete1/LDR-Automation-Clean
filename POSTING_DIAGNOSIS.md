# Posting Diagnosis (Jul 6, 2026)

## User-Reported Issues
1. **TikTok** — not posting at all
2. **YouTube** — yesterday posted SA video twice (duplicate), today nothing posted

## Key Findings

### Metricool API Test Result
- Creating a post with `providers: [{network:'tiktok'},{network:'youtube'}]` returns **200 OK**
- Both providers show `status: "PENDING"` — meaning the API ACCEPTS the post
- The issue is NOT in our code's API call — it's at Metricool's publish-time execution

### Brand Configuration (lifestyledesignrealtytexas, blogId 4807109)
- TikTok handle: `lifestyledesignrealtytx` (connected)
- YouTube channel: `UCqSfOt2aLrKKiROnY4kGBcQ` (connected)
- `tiktokBusinessTokenExpiration: null` — no expiration info available
- `tiktokAccountType: null` — account type not set

### Production Code (metricool.ts postToBrand)
- Sends providers: `[{network:'instagram'},{network:'tiktok'},{network:'youtube'}]`
- Sets `autoPublish: true` at top level
- Sets `instagramData.autoPublish: true` (IG-specific)
- Sets `tiktokData: { privacyOption: 'PUBLIC_TO_EVERYONE' }`
- Sets `youtubeData: { type: 'short', privacy: 'public', title: 'New build tour' }`
- Does NOT set `tiktokData.autoPublish: true` (potential issue!)

### Root Cause Analysis

**TikTok not posting:**
Most likely causes (from Metricool troubleshooting docs):
1. **TikTok token expired** (Error 40131) — needs reconnection in Metricool
2. **Privacy option mismatch** — `PUBLIC_TO_EVERYONE` might not be valid for their account type
3. **Missing autoPublish in tiktokData** — IG has it explicitly, TikTok doesn't

**YouTube duplicate SA:**
- The `publishNow` handler has a guard: `if (pick.status === "posted") return { ok: true, alreadyPosted: true }`
- But if the agent calls publishNow twice BEFORE the first one completes marking as "posted", both calls proceed
- Need to add a mutex/lock or atomic status check

**YouTube not posting today:**
- Today's picks have `hasDrive: 0` (Drive was disconnected at 8 AM)
- SA pick already `status: failed` (no Drive original)
- Austin/Dallas are `confirmed` but posting jobs haven't fired yet (2/3/4 PM)

## Fixes Needed

1. **TikTok:** Add `autoPublish: true` inside `tiktokData` object (matching instagramData pattern)
2. **YouTube duplicate:** Add atomic status check with `UPDATE ... WHERE status != 'posted'` before proceeding
3. **YouTube title:** Use actual video caption/city instead of hardcoded "New build tour"
4. **User action needed:** Reconnect TikTok in Metricool (Settings → Connections → Disconnect → Reconnect)

## Metricool TikTok Troubleshooting (from help.metricool.com)
- Privacy options must be explicitly set AND activated on the TikTok account
- TikTok tokens can expire silently — reconnection is the fix
- Only MP4/MOV, 3s-10min, 540px+ resolution, 128kbps audio
- `PUBLIC_TO_EVERYONE` is the correct value for public posts
- Personal accounts may have different privacy options than business accounts
