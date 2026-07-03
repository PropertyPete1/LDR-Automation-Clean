/**
 * Google Drive Video Index
 *
 * Syncs the "Camera Roll Real Estate Videos" folder into the drive_videos table.
 * Uses the `gws` CLI (pre-authenticated Google Workspace) to list files with
 * videoMediaMetadata (duration, resolution) and thumbnailLink.
 *
 * Called by the morning generation job so the AI matcher always has fresh metadata.
 */

import { execSync } from "child_process";
import { getDb } from "./db";
import { driveVideos } from "../drizzle/schema";

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
 * List all video files in the Drive folder using the gws CLI.
 * Paginates through all results (up to 10 pages of 100).
 */
export async function listDriveVideos(): Promise<DriveFile[]> {
  const allFiles: DriveFile[] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < 10; page++) {
    const params: Record<string, string | number> = {
      q: `'${DRIVE_FOLDER_ID}' in parents`,
      fields: FIELDS,
      pageSize: 100,
    };
    if (pageToken) params.pageToken = pageToken;

    const paramsJson = JSON.stringify(params);
    let output: string;
    try {
      output = execSync(`gws drive files list --params '${paramsJson}'`, {
        encoding: "utf-8",
        timeout: 30_000,
      });
    } catch (err) {
      console.error("[DriveIndex] gws CLI failed:", err);
      break;
    }

    let data: DriveListResponse;
    try {
      data = JSON.parse(output);
    } catch {
      console.error("[DriveIndex] Failed to parse gws output:", output.slice(0, 200));
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
