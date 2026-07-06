/**
 * Google Drive Token Manager
 * 
 * Architecture:
 * - The Manus agent cron has a fresh GOOGLE_WORKSPACE_CLI_TOKEN on every run
 * - Before calling generatePicks, the agent calls /api/scheduled/refreshDriveToken
 *   and passes its fresh token
 * - This module stores the token in the DB (settings table) and caches it in memory
 * - All Drive operations (driveIndex, drivePreprocess) call getDriveToken() from here
 * 
 * Priority:
 * 1. In-memory cached token (if set within last 50 minutes)
 * 2. Token from DB (settings: googleDriveAccessToken)
 * 3. Fallback to GOOGLE_WORKSPACE_CLI_TOKEN env var (sandbox/dev only)
 * 4. Fallback to GOOGLE_DRIVE_TOKEN env var (legacy)
 */

import * as db from "./db";

// In-memory cache
let cachedAccessToken: string | null = null;
let tokenSetAt: number = 0; // Unix timestamp in ms

// Tokens are valid for 60 minutes; we consider them stale after 50 minutes
const TOKEN_TTL_MS = 50 * 60 * 1000;

/**
 * Store a fresh Drive access token (called by the agent via /api/scheduled/refreshDriveToken).
 * Saves to both in-memory cache and DB for persistence across restarts.
 */
export async function setDriveToken(token: string): Promise<void> {
  cachedAccessToken = token;
  tokenSetAt = Date.now();
  
  // Persist to DB so it survives server restarts
  await db.setSetting("googleDriveAccessToken", token);
  await db.setSetting("googleDriveTokenSetAt", String(tokenSetAt));
  
  console.log(`[DriveAuth] Fresh token stored (${token.length} chars). Valid until ~${new Date(tokenSetAt + TOKEN_TTL_MS).toISOString()}`);
}

/**
 * Get a valid Google Drive access token.
 * 
 * Priority:
 * 1. In-memory cached token (if fresh)
 * 2. DB-stored token (if fresh)
 * 3. GOOGLE_WORKSPACE_CLI_TOKEN env var (sandbox/dev)
 * 4. GOOGLE_DRIVE_TOKEN env var (legacy)
 */
export async function getDriveToken(): Promise<string> {
  // 1. Check in-memory cache
  if (cachedAccessToken && (Date.now() - tokenSetAt) < TOKEN_TTL_MS) {
    return cachedAccessToken;
  }

  // 2. Check DB-stored token
  try {
    const dbToken = await db.getSetting("googleDriveAccessToken");
    const dbSetAt = await db.getSetting("googleDriveTokenSetAt");
    
    if (dbToken && dbSetAt) {
      const setAtMs = parseInt(dbSetAt, 10);
      if ((Date.now() - setAtMs) < TOKEN_TTL_MS) {
        // Token from DB is still fresh — cache it in memory
        cachedAccessToken = dbToken;
        tokenSetAt = setAtMs;
        return dbToken;
      }
    }
  } catch (err) {
    console.warn("[DriveAuth] Could not read token from DB:", (err as Error).message);
  }

  // 3. Fallback: platform-injected tokens (sandbox/dev only)
  const fallbackToken =
    process.env.GOOGLE_WORKSPACE_CLI_TOKEN || process.env.GOOGLE_DRIVE_TOKEN;

  if (fallbackToken) {
    return fallbackToken;
  }

  throw new Error(
    "[DriveAuth] No Google Drive token available. " +
    "The agent must call /api/scheduled/refreshDriveToken before generatePicks."
  );
}

/**
 * Health check: verify the current token can access Drive.
 */
export async function verifyDriveAccess(): Promise<{
  healthy: boolean;
  tokenAge?: string;
  error?: string;
}> {
  try {
    const token = await getDriveToken();
    const res = await fetch(
      "https://www.googleapis.com/drive/v3/about?fields=user",
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (res.ok) {
      const ageMs = tokenSetAt ? Date.now() - tokenSetAt : 0;
      const ageMin = Math.round(ageMs / 60000);
      return { healthy: true, tokenAge: `${ageMin} min` };
    }
    const errText = await res.text().catch(() => "");
    return {
      healthy: false,
      error: `Drive API ${res.status}: ${errText.slice(0, 200)}`,
    };
  } catch (err) {
    return {
      healthy: false,
      error: String(err),
    };
  }
}
