/**
 * memoryLayer.ts
 *
 * Per-lead + per-agent memory store for the AI Copilot.
 *
 * Every time the Copilot generates a suggestion or an agent sends a text,
 * the system extracts and stores key facts about the lead — what they care about,
 * what has been tried, what tone works, objections, intent signals.
 *
 * When the Copilot is asked to generate a reply suggestion, it reads the most
 * important memories for that lead + agent combination and injects them into
 * the prompt context window. This makes every suggestion smarter and more
 * personalized over time without requiring any manual input from agents.
 *
 * Memory categories:
 *   - lead_preference: what the lead wants (price range, area, beds, timeline)
 *   - contact_history: what has been tried and what happened
 *   - objection: concerns or blockers the lead has raised
 *   - intent_signal: signs of buying intent (or lack thereof)
 *   - general: anything else worth remembering
 *
 * Importance scoring (1-5):
 *   5 = critical — always inject first (e.g. "lead said they're ready to buy NOW")
 *   4 = high — inject if space allows
 *   3 = medium — inject for relevant queries
 *   1-2 = low — background context
 */

import { and, desc, eq } from "drizzle-orm";
import { leadMemory } from "../drizzle/schema";
import { invokeLLM } from "./_core/llm";
import { getDb } from "./db";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MemoryEntry {
  id: number;
  personId: number;
  agentName: string;
  memoryText: string;
  category: string;
  importanceScore: number;
  createdAt: Date;
}

export interface ExtractedMemory {
  memoryText: string;
  category: "lead_preference" | "contact_history" | "objection" | "intent_signal" | "general";
  importanceScore: number;
}

// ── Core memory functions ─────────────────────────────────────────────────────

/**
 * Store a new memory for a lead + agent pair.
 * Safe to call from anywhere — never throws.
 */
export async function storeMemory(
  personId: number,
  agentName: string,
  memoryText: string,
  category: string = "general",
  importanceScore: number = 1
): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    await db.insert(leadMemory).values({
      personId,
      agentName,
      memoryText: memoryText.slice(0, 1000), // cap at 1000 chars
      category,
      importanceScore: Math.min(5, Math.max(1, importanceScore)),
    });
  } catch (err) {
    console.warn(`[memoryLayer] storeMemory failed for lead ${personId}:`, err);
  }
}

/**
 * Retrieve the most important memories for a lead + agent pair.
 * Returns up to `limit` memories, sorted by importance (highest first).
 */
export async function getLeadMemories(
  personId: number,
  agentName: string,
  limit: number = 10
): Promise<MemoryEntry[]> {
  try {
    const db = await getDb();
    if (!db) return [];
    const rows = await db
      .select()
      .from(leadMemory)
      .where(
        and(
          eq(leadMemory.personId, personId),
          eq(leadMemory.agentName, agentName)
        )
      )
      .orderBy(desc(leadMemory.importanceScore), desc(leadMemory.createdAt))
      .limit(limit);
    return rows as MemoryEntry[];
  } catch {
    return [];
  }
}

/**
 * Format memories into a compact context string for LLM injection.
 * Returns empty string if no memories exist.
 */
export function formatMemoriesForContext(memories: MemoryEntry[]): string {
  if (memories.length === 0) return "";
  const lines = memories
    .sort((a, b) => b.importanceScore - a.importanceScore)
    .map(m => `• [${m.category}] ${m.memoryText}`);
  return `\n\nPersistent lead memory (from previous interactions):\n${lines.join("\n")}`;
}

/**
 * Use LLM to extract structured memories from a text exchange or FUB note.
 * Returns an array of memory entries to store.
 * Safe to call — returns [] on any failure.
 */
export async function extractMemoriesFromText(
  text: string,
  leadName: string,
  agentName: string
): Promise<ExtractedMemory[]> {
  if (!text || text.trim().length < 20) return [];

  try {
    const result = await invokeLLM({
      messages: [
        {
          role: "system",
          content: `You are a real estate CRM memory extractor. Given a text exchange or note about a lead, extract 1-3 key facts worth remembering for future outreach. Focus on:
- What the lead wants (price, area, timeline, bedrooms, features)
- What has been tried and what happened
- Objections or concerns the lead raised
- Buying intent signals (strong or weak)
- Anything specific that makes this lead unique

Return ONLY a JSON array. Each item must have:
- "memoryText": concise fact (max 150 chars)
- "category": one of "lead_preference", "contact_history", "objection", "intent_signal", "general"
- "importanceScore": integer 1-5 (5=critical, 1=background)

If nothing worth remembering, return [].`,
        },
        {
          role: "user",
          content: `Lead: ${leadName}\nAgent: ${agentName}\n\nText/Note:\n${text.slice(0, 1500)}`,
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "memory_extraction",
          strict: true,
          schema: {
            type: "object",
            properties: {
              memories: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    memoryText: { type: "string" },
                    category: {
                      type: "string",
                      enum: ["lead_preference", "contact_history", "objection", "intent_signal", "general"],
                    },
                    importanceScore: { type: "integer" },
                  },
                  required: ["memoryText", "category", "importanceScore"],
                  additionalProperties: false,
                },
              },
            },
            required: ["memories"],
            additionalProperties: false,
          },
        },
      },
    });

    const content = result.choices[0]?.message?.content;
    if (!content) return [];
    const parsed = JSON.parse(typeof content === "string" ? content : JSON.stringify(content));
    const memories: ExtractedMemory[] = (parsed.memories ?? []).slice(0, 3);
    return memories.filter(
      m => m.memoryText && m.memoryText.length > 5 && m.importanceScore >= 1
    );
  } catch (err) {
    console.warn("[memoryLayer] extractMemoriesFromText failed:", err);
    return [];
  }
}

/**
 * Auto-extract and store memories from a text exchange.
 * Called after a Copilot suggestion is accepted or a text is sent.
 * Fire-and-forget — never blocks the main flow.
 */
export async function autoExtractAndStore(
  personId: number,
  agentName: string,
  leadName: string,
  text: string
): Promise<void> {
  try {
    const memories = await extractMemoriesFromText(text, leadName, agentName);
    for (const m of memories) {
      await storeMemory(personId, agentName, m.memoryText, m.category, m.importanceScore);
    }
    if (memories.length > 0) {
      console.log(`[memoryLayer] Stored ${memories.length} memories for lead ${personId} (${leadName})`);
    }
  } catch (err) {
    console.warn("[memoryLayer] autoExtractAndStore failed:", err);
  }
}

/**
 * Get memory count for a lead (for dashboard display).
 */
export async function getLeadMemoryCount(personId: number): Promise<number> {
  try {
    const db = await getDb();
    if (!db) return 0;
    const rows = await db
      .select({ id: leadMemory.id })
      .from(leadMemory)
      .where(eq(leadMemory.personId, personId));
    return rows.length;
  } catch {
    return 0;
  }
}
