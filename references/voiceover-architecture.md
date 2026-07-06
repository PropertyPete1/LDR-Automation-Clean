# Voiceover Pipeline Architecture

## Files Created
- `server/elevenlabs.ts` — ElevenLabs TTS service (voice ID: ymv1q5WLElzdmrHdtgsw "Peters pro voice", model: eleven_multilingual_v2)
- `server/voiceoverAudioIntel.ts` — Audio intelligence (speech vs music detection via ffprobe)
- `server/voiceoverScript.ts` — LLM script generation (paced to video duration, ~2.45 wps)
- `server/voiceoverRender.ts` — Full render pipeline (TTS → atempo → assembly → captions → LUFS)
- `server/elevenlabs.test.ts` — API key validation test

## DB Tables (applied via migration 0011)
- `voiceover_jobs` — pickId, reelId, city, status (detecting→scripting→pending_approval→generating_audio→duration_mismatch→rendering→preview_ready→approved→failed), audioType, originalAudioMode (duck/mute), videoDurationSec, script, voiceId, charactersUsed, audioDurationSec, durationMismatchPct, audioStorageKey, renderedVideoStorageKey, driveRenderedFileId, errorMessage
- `voiceover_budget` — month (YYYY-MM), charactersUsed, budgetLimit (default 100000)

## DB Helpers Added to db.ts
- insertVoiceoverJob, getVoiceoverJobByPickId, getVoiceoverJob, updateVoiceoverJob, getRecentVoiceoverJobs
- getOrCreateBudget, addCharacterUsage, updateBudgetLimit

## Still TODO (Phase 4 & 5)
1. Add voiceover tRPC router procedures to routers.ts:
   - voiceover.startJob (creates job, triggers detection + scripting)
   - voiceover.getJob (get job status/details by pickId)
   - voiceover.approveScript (approve script, trigger TTS + render)
   - voiceover.updateScript (edit script before approval)
   - voiceover.regenerateScript (re-run LLM)
   - voiceover.regenerateAudio (re-run TTS with approved script)
   - voiceover.approveVideo (mark rendered video as final)
   - voiceover.budget (get current month budget)

2. Dashboard UI additions to Home.tsx PickCard:
   - Voiceover toggle ("Add Peter voiceover" on/off)
   - Script editor panel (shows when voiceover enabled)
   - Status indicator (detecting → scripting → pending_approval → etc)
   - Approve script button
   - Video preview (rendered video player)
   - Regenerate buttons (script / audio)
   - Duration mismatch warning
   - Budget meter (monthly characters used/limit)

3. Pipeline integration:
   - When voiceover is approved, use rendered video URL instead of Drive original for Metricool posting
   - Upload rendered video to Drive "Rendered - Voiceover" folder
   - Character usage tracking per job
   - Nothing posts automatically — human approval required for voiceover

## Key Design Decisions
- Voiceover is OPT-IN per pick (toggle, default OFF)
- Original audio mode: "duck" (15-20% volume) or "mute" (replace entirely)
- Caption style: bold, white text, black outline, centered lower-third, safe-zone aware
- Duration tolerance: ±5% with atempo adjustment
- Budget: 100k chars/month default, warn at 80%, pause at 100%
- Rendered video saved to S3 + Drive "Rendered - Voiceover" folder
