/**
 * draftParser.ts — Belt-and-suspenders parser to strip AI reasoning/meta-commentary
 * from SMS draft responses before they reach the user's tap-to-text field.
 */

// Patterns that indicate meta-commentary (case-insensitive first-line checks)
const META_COMMENTARY_PATTERNS = [
  /^the notes?\s+(don't|do not|doesn't|contain|show|mention|indicate|only)/i,
  /^i('ll| will)\s+(craft|write|create|compose|draft|send|make)/i,
  /^here('s| is)\s+(a|the|my)/i,
  /^this message/i,
  /^based on/i,
  /^since (the|there|we|i|notes)/i,
  /^given (that|the)/i,
  /^looking at (the|their)/i,
  /^let me/i,
  /^i('m| am) going to/i,
  /^okay,?\s*(so|here|i)/i,
  /^alright,?\s*(so|here|i)/i,
  /^sure,?\s*(here|i)/i,
  /^(thinking|reasoning|analysis|approach|strategy):/i,
  /^for this (lead|person|client|contact)/i,
  /^my (approach|strategy|thought)/i,
];

// Patterns that indicate a line is the actual SMS (heuristic)
const SMS_INDICATORS = [
  /^hey\b/i,
  /^hi\b/i,
  /^hello\b/i,
  /^what's up/i,
  /^hope (you|your|everything)/i,
  /^just (wanted|checking|reaching|following|curious)/i,
  /^quick question/i,
  /^still (looking|interested|thinking)/i,
  /^any (update|news|thoughts)/i,
  /^how('s| is| are) (the|your|it|things)/i,
  /^are you still/i,
  /^wanted to/i,
  /^thought of you/i,
  /^saw (a|some|this)/i,
];

/**
 * Strips meta-commentary/reasoning from an AI-generated SMS draft.
 * Returns ONLY the clean SMS message text.
 */
export function stripDraftReasoning(raw: string): string {
  if (!raw || typeof raw !== "string") return "";

  let text = raw.trim();

  // Step 1: Remove surrounding quotes (including smart quotes)
  text = text.replace(/^["'\u2018\u2019\u201C\u201D]|["'\u2018\u2019\u201C\u201D]$/g, "");
  text = text.trim();

  // Step 2: If the response is a single short line (≤200 chars) with no meta patterns, it's likely clean
  if (text.length <= 200 && !text.includes("\n")) {
    const hasMeta = META_COMMENTARY_PATTERNS.some((p) => p.test(text));
    if (!hasMeta) return text;
  }

  // Step 3: Split into paragraphs (double newline) or lines (single newline)
  const paragraphs = text
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter(Boolean);

  // If single paragraph but has newline-separated lines, split by lines
  if (paragraphs.length === 1 && text.includes("\n")) {
    const lines = text.split(/\n/).map((l) => l.trim()).filter(Boolean);
    // Find the last line that looks like an SMS (not meta)
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].replace(/^["'\u2018\u2019\u201C\u201D]|["'\u2018\u2019\u201C\u201D]$/g, "").trim();
      const isMeta = META_COMMENTARY_PATTERNS.some((p) => p.test(line));
      const isSms = SMS_INDICATORS.some((p) => p.test(line));
      if (isSms && !isMeta && line.length >= 10 && line.length <= 200) {
        return line;
      }
    }
    // If no SMS indicator found, take the last non-meta line
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].replace(/^["'\u2018\u2019\u201C\u201D]|["'\u2018\u2019\u201C\u201D]$/g, "").trim();
      const isMeta = META_COMMENTARY_PATTERNS.some((p) => p.test(line));
      if (!isMeta && line.length >= 10 && line.length <= 200) {
        return line;
      }
    }
  }

  if (paragraphs.length === 1) {
    // Single paragraph — check if it starts with meta-commentary
    const lines = text.split(/\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length > 1) {
      const firstLine = lines[0];
      const isMeta = META_COMMENTARY_PATTERNS.some((p) => p.test(firstLine));
      if (isMeta) {
        // Try to find the actual SMS in subsequent lines
        for (let i = 1; i < lines.length; i++) {
          const line = lines[i].replace(/^["'""]|["'""]$/g, "").trim();
          if (line.length > 10 && line.length <= 200) {
            const lineIsSms = SMS_INDICATORS.some((p) => p.test(line)) ||
              !META_COMMENTARY_PATTERNS.some((p) => p.test(line));
            if (lineIsSms) return line;
          }
        }
      }
    }
    // If single paragraph has meta at start, try stripping common prefixes
    const metaStripped = stripLeadingMeta(text);
    if (metaStripped && metaStripped.length >= 10) return metaStripped;
    return text;
  }

  // Multiple paragraphs — find the one that looks like an SMS
  // Strategy: skip paragraphs that match meta patterns, take the first clean one
  for (const para of paragraphs) {
    const cleanPara = para.replace(/^["'""]|["'""]$/g, "").trim();
    const isMeta = META_COMMENTARY_PATTERNS.some((p) => p.test(cleanPara));
    if (!isMeta && cleanPara.length >= 10 && cleanPara.length <= 250) {
      // This looks like the actual SMS
      return cleanPara;
    }
  }

  // Fallback: if we couldn't isolate, take the last paragraph (most likely the SMS)
  const lastPara = paragraphs[paragraphs.length - 1]
    .replace(/^["'""]|["'""]$/g, "")
    .trim();
  if (lastPara.length >= 10 && lastPara.length <= 250) {
    return lastPara;
  }

  // Final fallback: return the whole thing stripped of quotes
  return text.replace(/^["'""]|["'""]$/g, "").trim();
}

/**
 * Attempt to strip a leading meta-commentary sentence from a single block.
 * E.g., "I'll craft something warm. Hey Lisa, how's the search going?"
 * → "Hey Lisa, how's the search going?"
 */
function stripLeadingMeta(text: string): string | null {
  // Split on sentence boundaries (period/dash followed by space and capital)
  const parts = text.split(/(?<=[.!?—–])\s+(?=[A-Z])/);
  if (parts.length < 2) return null;

  // Check if first part is meta
  const firstIsMeta = META_COMMENTARY_PATTERNS.some((p) => p.test(parts[0]));
  if (!firstIsMeta) return null;

  // Return everything after the meta part
  const remainder = parts.slice(1).join(" ").trim();
  if (remainder.length >= 10) return remainder;
  return null;
}
