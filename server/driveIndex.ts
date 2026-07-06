/**
 * Google Drive Video Index
 *
 * Syncs the "Camera Roll Real Estate Videos" folder into the drive_videos table.
 * Uses the OAuth2 refresh token flow (driveAuth.ts) for reliable, auto-refreshing
 * authentication. Falls back to GOOGLE_WORKSPACE_CLI_TOKEN in dev.
 *
 * Called by the morning generation job so the AI matcher always has fresh metadata.
 */

import { getDb } from "./db";
import { driveVideos } from "../drizzle/schema";
import { getDriveToken as getTokenFromAuth } from "./driveAuth";

/** The Google Drive folder ID for "Camera Roll Real Estate Videos". */
const DRIVE_FOLDER_ID = "16mNnK1avek0LUljjFPZ5iNxON2OJZod7";

/** Fields we request from the Drive API. */
const FIELDS = "files(id,name,mimeType,size,videoMediaMetadata,thumbnailLink,createdTime),nextPageToken";

interface DriveFile {
  id: string;
  name: string;
  mimeType?: string;
  size?: string;
  videoMediaMetadata?: {
    durationMillis?: string;
    height?: number;
    width?: number;
  };
  thumbnailLink?: string;
  createdTime?: string;
}

interface DriveListResponse {
  files?: DriveFile[];
  nextPageToken?: string;
}

/**
 * Get the Google Drive OAuth token.
 * Uses the auto-refreshing OAuth2 flow from driveAuth.ts.
 */
async function getDriveTokenLocal(): Promise<string> {
  return getTokenFromAuth();
}

/**
 * List all video files in the Drive folder using the Google Drive REST API.
 * Paginates through all results (up to 10 pages of 100).
 */
export async function listDriveVideos(): Promise<DriveFile[]> {
  const allFiles: DriveFile[] = [];
  let pageToken: string | undefined;
  const token = await getDriveTokenLocal();

  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams({
      q: `'${DRIVE_FOLDER_ID}' in parents`,
      fields: FIELDS,
      pageSize: "100",
    });
    if (pageToken) params.set("pageToken", pageToken);

    let data: DriveListResponse;
    try {
      const res = await fetch(
        `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      if (!res.ok) {
        const errText = await res.text();
        console.error(`[DriveIndex] Drive API error (${res.status}): ${errText.slice(0, 300)}`);
        break;
      }

      data = await res.json() as DriveListResponse;
    } catch (err) {
      console.error("[DriveIndex] Drive API fetch failed:", err);
      break;
    }

    if (data.files) {
      allFiles.push(...data.files);
    }

    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }

  return allFiles;
}

/**
 * Lightweight health check: verify the Drive token is valid by listing 1 file.
 * Returns { healthy: true } if the API responds with 200, or { healthy: false, error }
 * if the token is expired/revoked/missing.
 */
export async function driveHealthCheck(): Promise<{ healthy: boolean; error?: string }> {
  try {
    const token = await getDriveTokenLocal();
    const params = new URLSearchParams({
      q: `'${DRIVE_FOLDER_ID}' in parents`,
      fields: "files(id)",
      pageSize: "1",
    });
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (res.ok) {
      return { healthy: true };
    }
    const errText = await res.text().catch(() => "");
    return { healthy: false, error: `Drive API ${res.status}: ${errText.slice(0, 200)}` };
  } catch (err) {
    const e = err as Error;
    return { healthy: false, error: e.message };
  }
}

/**
 * Sync Drive folder → drive_videos table.
 * Upserts all video files found in the folder. Idempotent.
 * Returns the count of files synced.
 */
export async function syncDriveIndex(): Promise<{ synced: number; total: number }> {
  const db = await getDb();
  if (!db) return { synced: 0, total: 0 };

  const files = await listDriveVideos();
  const now = Date.now();
  let synced = 0;

  for (const f of files) {
    // Only index video files
    if (!f.mimeType?.startsWith("video/")) continue;

    const durationMs = f.videoMediaMetadata?.durationMillis
      ? parseInt(f.videoMediaMetadata.durationMillis, 10)
      : null;
    const width = f.videoMediaMetadata?.width ?? null;
    const height = f.videoMediaMetadata?.height ?? null;
    const sizeBytes = f.size ? parseInt(f.size, 10) : null;
    const driveCreatedAt = f.createdTime ? new Date(f.createdTime).getTime() : null;

    await db
      .insert(driveVideos)
      .values({
        driveFileId: f.id,
        fileName: f.name,
        mimeType: f.mimeType ?? null,
        sizeBytes,
        durationMs,
        width,
        height,
        thumbnailUrl: f.thumbnailLink ?? null,
        hostedThumbnailUrl: null, // populated separately if needed
        driveCreatedAt,
        lastIndexedAt: now,
      })
      .onDuplicateKeyUpdate({
        set: {
          fileName: f.name,
          mimeType: f.mimeType ?? null,
          sizeBytes,
          durationMs,
          width,
          height,
          thumbnailUrl: f.thumbnailLink ?? null,
          driveCreatedAt,
          lastIndexedAt: now,
        },
      });
    synced++;
  }

  console.log(`[DriveIndex] Synced ${synced} videos from Drive folder (${files.length} total files)`);
  return { synced, total: files.length };
}

/**
 * Get all indexed Drive videos from the database.
 */
export async function getAllDriveVideos() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(driveVideos);
}

/**
 * Get Drive videos filtered by duration range (for fast matching).
 * Returns videos whose duration is within ±toleranceMs of the target.
 */
export async function getDriveVideosByDuration(
  targetDurationMs: number,
  toleranceMs: number = 3000
) {
  const all = await getAllDriveVideos();
  return all.filter(v => {
    if (!v.durationMs) return false;
    return Math.abs(v.durationMs - targetDurationMs) <= toleranceMs;
  });
}
