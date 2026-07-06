# AI Voiceover Feature Requirements

## ElevenLabs Config
- API Key: stored as ELEVENLABS_API_KEY env var
- Voice: "Peter's Pro Voice" — look up voice ID via GET /v1/voices, store in config
- Model: ElevenLabs v3
- Voiceover-only (no avatar/video generation services)

## 1. Source Audio Intelligence
- Detect whether source video contains prominent speech (someone talking to camera)
- If it does, flag in dashboard: option to fully mute original audio instead of ducking
- Videos with only music/ambient audio are ideal candidates — surface status per video

## 2. Voiceover Script Generation
- Detect video's exact duration via ffprobe
- Generate script sized to fill FULL video length (start to end)
- Pacing: ~2.3–2.6 words per second
- ElevenLabs "Enhance" does NOT work via API — write emotional delivery tags directly: [excited], [thoughtful], [confident]

## 3. Script Tone & Brand Rules
- Sound like real estate professional — conversational, confident, no hype
- Never include claims about pricing/incentives/availability unless from source caption
- No fair-housing risk language
- End with soft CTA (vary it: follow, comment, DM)
- Show script in approval dashboard BEFORE audio generation — must be editable/approvable

## 4. Audio Generation & Duration Matching
- On approval, call ElevenLabs TTS with Peter's Pro Voice + approved script
- Save audio alongside source video (from Drive originals)
- Compare audio duration to video duration
- If within ±5%: stretch/compress with FFmpeg atempo (0.95x–1.05x)
- If beyond tolerance: flag in dashboard with mismatch amount for script edit + regenerate
- Never post video where voiceover doesn't span full length

## 5. Video Assembly (FFmpeg)
- Layer voiceover onto video, full duration start to finish
- Duck original audio to 15–20% volume (or fully mute if selected in step 1)
- Normalize voiceover to ~-14 LUFS for social

## 6. Captions
- Burn in word-by-word captions synced to voiceover for full video
- Use forced alignment (WhisperX or ffmpeg-compatible) for word timestamps — don't re-transcribe
- Style: bold, centered lower-middle third, safe-zone aware for Reels, white text with black outline

## 7. Preview Before Posting
- Watch final rendered video (voiceover + captions + audio mix) before Metricool
- "Regenerate audio" button that reuses approved script (TTS varies between runs)

## 8. Pipeline Integration
- Toggle per post: "Add Peter voiceover" (on/off), default OFF
- Final rendered video with voiceover + captions = transformed version for Metricool posting

## 9. Cost Controls
- Log ElevenLabs character usage per video
- Monthly character budget setting; warn at 80%, pause generation at 100%
- Cache generated audio: reuse if script unchanged (e.g. re-render for caption style change)

## 10. File Management
- Save final rendered videos to Google Drive folder "Rendered - Voiceover"
- Naming: {original_filename}_vo_{date}.mp4
- Keep intermediate files (raw audio, alignment JSON) for 30 days, then clean up

## 11. Error Handling
- If ElevenLabs API fails, don't post — flag for retry
- Validate final video meets IG Reels specs (9:16, codec, length limits) after FFmpeg

## Key Rule
- Nothing posts automatically — everything goes through existing human approval step
