/**
 * Drive Matcher — AI Vision Matching
 *
 * Given an IG reel (thumbnail URL, caption, duration), finds the matching
 * original file in the Google Drive "Camera Roll Real Estate Videos" folder.
 *
 * Strategy:
 * 1. Fast filter: narrow candidates by duration (±3 seconds)
 * 2. AI vision: send IG thumbnail + Drive thumbnails to gemini-3-flash-preview
 * 3. Structured output: { matchedFileId, confidence }
 *
 * If no match is found, returns null (caller skips this pick).
 */

import { invokeLLM } from "./_core/llm";
import { getDriveVideosByDuration, getAllDriveVideos } from "./driveIndex";
import type { DriveVideo } from "../drizzle/schema";

export interface MatchResult {
  matchedFileId: string;
  fileName: string;
  confidence: "high" | "medium" | "low";
}

interface MatchCandidate {
  igThumbnailUrl: string;
  igCaption?: string | null;
  igDurationMs?: number | null;
}

/**
 * Find the matching Drive original for an IG reel.
 *
 * @param candidate - The IG reel's thumbnail, caption, and duration
 * @returns The matched Drive file info, or null if no match found
 */
export async function findDriveMatch(
  candidate: MatchCandidate
): Promise<MatchResult | null> {
  const { igThumbnailUrl, igCaption, igDurationMs } = candidate;

  if (!igThumbnailUrl) {
    console.log("[DriveMatcher] No IG thumbnail URL, cannot match");
    return null;
  }

  // Step 1: Get candidates filtered by duration (if we have duration info)
  let candidates: DriveVideo[];
  if (igDurationMs && igDurationMs > 0) {
    // First try tight tolerance (±3s)
    candidates = await getDriveVideosByDuration(igDurationMs, 3000);
    // If too few, widen to ±5s
    if (candidates.length < 2) {
      candidates = await getDriveVideosByDuration(igDurationMs, 5000);
    }
    // If still none, fall back to all videos with thumbnails
    if (candidates.length === 0) {
      const all = await getAllDriveVideos();
      candidates = all.filter(v => v.thumbnailUrl);
    }
  } else {
    // No duration info — use all videos with thumbnails
    const all = await getAllDriveVideos();
    candidates = all.filter(v => v.thumbnailUrl);
  }

  // Only consider candidates that have thumbnails (Google-generated)
  const withThumbs = candidates.filter(v => v.thumbnailUrl);
  if (withThumbs.length === 0) {
    console.log("[DriveMatcher] No Drive candidates have thumbnails, cannot match");
    return null;
  }

  // Step 2: AI vision matching in batches of 5
  // Process batches until we find a high/medium confidence match
  const BATCH_SIZE = 5;
  for (let i = 0; i < withThumbs.length; i += BATCH_SIZE) {
    const batch = withThumbs.slice(i, i + BATCH_SIZE);
    const result = await matchBatchWithVision(igThumbnailUrl, igCaption, batch);
    if (result) return result;
  }

  console.log(`[DriveMatcher] No match found among ${withThumbs.length} Drive candidates`);
  return null;
}

/**
 * Send a batch of Drive thumbnails + the IG thumbnail to AI vision for comparison.
 */
async function matchBatchWithVision(
  igThumbnailUrl: string,
  igCaption: string | null | undefined,
  driveCandidates: DriveVideo[]
): Promise<MatchResult | null> {
  // Build image content: IG thumbnail first, then Drive thumbnails
  const imageContent: Array<{
    type: "image_url";
    image_url: { url: string; detail: "low" };
  }> = [
    { type: "image_url", image_url: { url: igThumbnailUrl, detail: "low" } },
    ...driveCandidates.map(v => ({
      type: "image_url" as const,
      image_url: { url: v.thumbnailUrl!, detail: "low" as const },
    })),
  ];

  // Build the candidate list description for the prompt
  const candidateList = driveCandidates
    .map((v, idx) => `  [${idx + 1}] fileId="${v.driveFileId}" name="${v.fileName}" duration=${v.durationMs ? Math.round(v.durationMs / 1000) + "s" : "unknown"}`)
    .join("\n");

  const captionHint = igCaption
    ? `\nIG reel caption (for context): "${igCaption.slice(0, 300)}"`
    : "";

  const prompt = `You are a video matching AI. Your job is to determine which Google Drive video file is the SAME video as an Instagram reel, based on their thumbnail images.

The FIRST image is the Instagram reel's thumbnail (the video we want to find the original of).
The REMAINING ${driveCandidates.length} images are thumbnails from Google Drive video files (potential originals).${captionHint}

Drive file candidates:
${candidateList}

Rules:
- "Match" means: the Drive thumbnail shows the SAME video content as the IG reel thumbnail — same property, same angle, same scene, same footage.
- The IG version may be cropped, color-graded differently, or have text overlays — but the underlying footage is the same.
- If you are NOT confident that any Drive file matches, respond with matchedIndex: -1.
- Only respond with a match if you are reasonably sure (the scene, property, and angle clearly match).

Respond with ONLY a JSON object:
- If a match is found: {"matchedIndex": <1-based index>, "confidence": "high"|"medium"|"low"}
- If no match: {"matchedIndex": -1, "confidence": "low"}`;

  try {
    const response = await invokeLLM({
      model: "gemini-3-flash-preview",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            ...imageContent,
          ],
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "drive_match_result",
          strict: true,
          schema: {
            type: "object",
            properties: {
              matchedIndex: {
                type: "integer",
                description: "1-based index of the matched Drive file, or -1 if no match",
              },
              confidence: {
                type: "string",
                enum: ["high", "medium", "low"],
                description: "Confidence level of the match",
              },
            },
            required: ["matchedIndex", "confidence"],
            additionalProperties: false,
          },
        },
      },
      // Gemini: use max_tokens, not max_completion_tokens
      max_tokens: 2048,
    } as any);

    const content = response?.choices?.[0]?.message?.content;
    if (!content) {
      console.warn("[DriveMatcher] LLM returned empty content");
      return null;
    }

    const parsed = typeof content === "string" ? JSON.parse(content) : content;
    const { matchedIndex, confidence } = parsed;

    if (matchedIndex === -1 || matchedIndex < 1 || matchedIndex > driveCandidates.length) {
      return null;
    }

    // Only accept high or medium confidence matches
    if (confidence === "low") {
      console.log(`[DriveMatcher] Low confidence match for index ${matchedIndex}, skipping`);
      return null;
    }

    const matched = driveCandidates[matchedIndex - 1];
    console.log(`[DriveMatcher] Matched! fileId=${matched.driveFileId} name="${matched.fileName}" confidence=${confidence}`);
    return {
      matchedFileId: matched.driveFileId,
      fileName: matched.fileName,
      confidence,
    };
  } catch (err) {
    console.error("[DriveMatcher] Vision matching failed:", err);
    return null;
  }
}
