/**
 * Voiceover Script Generation
 *
 * Uses LLM to generate a voiceover script for a real estate video reel.
 * The script is sized to fill the full video duration based on pacing estimates.
 *
 * Key rules:
 * - Conversational, confident real estate professional tone
 * - No invented pricing/incentives unless from source caption
 * - No fair-housing risk language
 * - Soft, varied CTA at the end
 * - Emotional delivery tags for ElevenLabs: [excited], [thoughtful], [confident]
 * - Pacing: ~2.3–2.6 words per second
 */

import { invokeLLM } from "./_core/llm";

interface ScriptGenerationInput {
  /** Video duration in seconds */
  videoDurationSec: number;
  /** Original caption from the IG reel */
  caption: string;
  /** City: austin, san_antonio, dallas */
  city: string;
  /** Audio type detected: speech, music_only, silent */
  audioType: string;
}

interface GeneratedScript {
  script: string;
  wordCount: number;
  estimatedDurationSec: number;
  wordsPerSecond: number;
}

const WORDS_PER_SECOND_MIN = 2.3;
const WORDS_PER_SECOND_MAX = 2.6;
const WORDS_PER_SECOND_TARGET = 2.45;

/**
 * Generate a voiceover script sized to fill the full video duration.
 */
export async function generateVoiceoverScript(input: ScriptGenerationInput): Promise<GeneratedScript> {
  const targetWordCount = Math.round(input.videoDurationSec * WORDS_PER_SECOND_TARGET);
  const minWords = Math.round(input.videoDurationSec * WORDS_PER_SECOND_MIN);
  const maxWords = Math.round(input.videoDurationSec * WORDS_PER_SECOND_MAX);

  const cityLabel = {
    austin: "Austin, Texas",
    san_antonio: "San Antonio, Texas",
    dallas: "Dallas–Fort Worth, Texas",
  }[input.city] || input.city;

  const systemPrompt = `You are a voiceover script writer for a real estate professional named Peter Allen who runs Lifestyle Design Realty in Texas. You write scripts that will be read aloud as voiceovers layered on top of property tour videos posted as Instagram Reels.

VOICE & TONE:
- Sound like a knowledgeable real estate professional speaking naturally to camera
- Conversational, confident, warm — NOT hype-y, NOT influencer-style
- Use natural speech patterns with varied pacing (some sentences shorter, some longer)
- Include emotional delivery tags in brackets for the TTS engine: [excited], [thoughtful], [confident], [warm], [serious], [casual]
- Place delivery tags at the START of sentences or phrases where the emotion should shift

CONTENT RULES:
- NEVER invent specific pricing, rates, incentives, or availability unless that exact info appears in the source caption
- NEVER use fair-housing risk language (don't describe neighborhoods by who lives there, don't steer toward/away from demographics)
- If the caption mentions specific numbers (price, sq ft, rates), you MAY reference them
- Focus on: property features, lifestyle benefits, neighborhood character, investment potential, market context
- Make the viewer feel like they're getting insider knowledge from a trusted advisor

STRUCTURE:
- Open with a hook that stops the scroll (first 2-3 seconds are critical)
- Build through the middle with property/area details
- End with a soft, varied CTA (rotate between: "follow for more", "comment below", "DM me", "drop a comment", "save this for later")
- Do NOT use the same CTA every time — vary it naturally

FORMAT:
- Write ONLY the spoken text (no stage directions, no [pause] markers, no timestamps)
- Delivery tags like [excited] or [confident] ARE allowed — they control TTS emotion
- No quotation marks around the script
- No line numbers or bullet points
- Write as one continuous flowing script`;

  const userPrompt = `Write a voiceover script for a ${cityLabel} property video.

VIDEO DURATION: ${input.videoDurationSec} seconds
TARGET WORD COUNT: ${targetWordCount} words (minimum ${minWords}, maximum ${maxWords})
AUDIO TYPE: ${input.audioType === "speech" ? "Original video has someone talking — voiceover will replace their audio entirely" : "Original video has music/ambient audio — voiceover will be layered on top with the music ducked"}

SOURCE CAPTION (use any factual details from this, but do NOT copy it verbatim):
${input.caption || "(No caption available)"}

IMPORTANT: The script MUST be approximately ${targetWordCount} words to fill the full ${input.videoDurationSec}-second video. Count carefully. Every second of video needs voiceover coverage.`;

  const response = await invokeLLM({
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  const rawContent = response.choices[0]?.message?.content;
  const script = (typeof rawContent === "string" ? rawContent : "").trim();
  const wordCount = script.split(/\s+/).filter((w: string) => !w.startsWith("[") || !w.endsWith("]")).length;
  const estimatedDurationSec = Math.round(wordCount / WORDS_PER_SECOND_TARGET);

  return {
    script,
    wordCount,
    estimatedDurationSec,
    wordsPerSecond: wordCount / input.videoDurationSec,
  };
}

/**
 * Validate a script's word count against video duration.
 * Returns whether it's within acceptable range.
 */
export function validateScriptLength(
  script: string,
  videoDurationSec: number
): { valid: boolean; wordCount: number; estimatedSec: number; mismatchPct: number } {
  // Don't count delivery tags as words
  const cleanScript = script.replace(/\[[\w]+\]/g, "").trim();
  const wordCount = cleanScript.split(/\s+/).filter(Boolean).length;
  const estimatedSec = Math.round(wordCount / WORDS_PER_SECOND_TARGET);
  const mismatchPct = Math.round(((estimatedSec - videoDurationSec) / videoDurationSec) * 100);

  return {
    valid: Math.abs(mismatchPct) <= 15, // Allow up to 15% mismatch in script estimation
    wordCount,
    estimatedSec,
    mismatchPct,
  };
}
