/**
 * IG Scraper — Fetches reels from Instagram via the MCP tool (get_post_list + get_post_insights).
 *
 * This module is called by the morning generation job to refresh the ig_reels table
 * with the latest engagement data (views, likes, comments, shares, saved).
 *
 * In production, the MCP tools are NOT available (they only work in the sandbox/agent context).
 * So this module is designed to be called from a scheduled Manus agent task that HAS
 * the Instagram connector, and the results are stored in the DB for the Heartbeat cron to use.
 *
 * For the Heartbeat cron (which runs without MCP), we just read from the ig_reels table
 * that was populated by the agent's earlier scrape run.
 */

import { getDb } from "./db";
import { igReels } from "../drizzle/schema";
import { eq } from "drizzle-orm";
import { classifyMarket } from "./geoClassify";
import { storagePut } from "./storage";

export interface ScrapedReel {
  igMediaId: string;
  caption: string;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saved: number;
  reelLink: string;
  postedAt: number; // epoch ms
  thumbnailUrl?: string; // IG CDN thumbnail (may expire)
}

/**
 * Compute engagement score for ranking.
 * Weighted: views are the base, with multipliers for active engagement signals.
 */
export function computeEngagementScore(reel: {
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saved: number;
}): number {
  return reel.views + reel.likes * 10 + reel.comments * 20 + reel.shares * 30 + reel.saved * 15;
}

/**
 * Upsert scraped reels into the ig_reels table.
 * Called by the scheduled agent task that has the Instagram MCP connector.
 *
 * For each reel:
 * 1. Compute engagement score
 * 2. Classify city (keyword + AI fallback)
 * 3. If thumbnail provided and not yet hosted, upload to S3
 * 4. Upsert into ig_reels
 */
export async function upsertScrapedReels(reels: ScrapedReel[]): Promise<{ upserted: number }> {
  const database = await getDb();
  if (!database) return { upserted: 0 };

  let upserted = 0;
  for (const reel of reels) {
    const engagementScore = computeEngagementScore(reel);

    // Classify city from caption
    const city = await classifyMarket(reel.caption);

    // Host the thumbnail if we have one (so it doesn't expire)
    let thumbnailStorageKey: string | null = null;
    if (reel.thumbnailUrl) {
      try {
        const resp = await fetch(reel.thumbnailUrl);
        if (resp.ok) {
          const buf = Buffer.from(await resp.arrayBuffer());
          const key = `ig-thumbs/${reel.igMediaId}.jpg`;
          const { key: storedKey } = await storagePut(key, buf, "image/jpeg");
          thumbnailStorageKey = storedKey;
        }
      } catch {
        // If thumbnail fetch fails, continue without it
      }
    }

    await database
      .insert(igReels)
      .values({
        igMediaId: reel.igMediaId,
        thumbnailStorageKey,
        caption: reel.caption,
        views: reel.views,
        likes: reel.likes,
        comments: reel.comments,
        shares: reel.shares,
        saved: reel.saved,
        engagementScore,
        city,
        reelLink: reel.reelLink,
        postedAt: reel.postedAt,
        lastScrapedAt: Date.now(),
      })
      .onDuplicateKeyUpdate({
        set: {
          views: reel.views,
          likes: reel.likes,
          comments: reel.comments,
          shares: reel.shares,
          saved: reel.saved,
          engagementScore,
          city,
          caption: reel.caption,
          thumbnailStorageKey: thumbnailStorageKey ?? undefined,
          lastScrapedAt: Date.now(),
        },
      });
    upserted++;
  }

  console.log(`[IgScraper] Upserted ${upserted} reels into ig_reels`);
  return { upserted };
}

/**
 * Get all reels for a city, sorted by engagement score descending.
 */
export async function getReelsByCity(city: "austin" | "san_antonio" | "dallas") {
  const database = await getDb();
  if (!database) return [];
  return database
    .select()
    .from(igReels)
    .where(eq(igReels.city, city))
    .orderBy(igReels.engagementScore);
}

/**
 * Get all reels sorted by engagement score descending.
 */
export async function getAllReels() {
  const database = await getDb();
  if (!database) return [];
  return database.select().from(igReels);
}
