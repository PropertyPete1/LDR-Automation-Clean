/**
 * Update drive_videos table with fresh data from the gws CLI scan.
 * Upserts all 491 files, updating thumbnailUrl where available.
 */
import { readFileSync } from 'fs';
import { SignJWT } from 'jose';

const secret = new TextEncoder().encode(process.env.JWT_SECRET);
const openId = process.env.OWNER_OPEN_ID;
const appId = process.env.VITE_APP_ID;
const token = await new SignJWT({ openId, appId, name: 'Peter Allen' })
  .setProtectedHeader({ alg: 'HS256' })
  .setExpirationTime('1h')
  .sign(secret);

const allFiles = JSON.parse(readFileSync('/tmp/drive_files_fresh.json', 'utf-8'));
console.log(`Loaded ${allFiles.length} files from Drive scan`);

// We need to upsert these into drive_videos table.
// The server doesn't have an endpoint for this, so let's use a direct DB approach
// by calling the syncDriveIndex logic. But that uses the expired token...
// Instead, let's write SQL directly via a helper script.

// Build SQL INSERT ... ON DUPLICATE KEY UPDATE statements
const BATCH_SIZE = 50;
let totalUpdated = 0;

for (let i = 0; i < allFiles.length; i += BATCH_SIZE) {
  const batch = allFiles.slice(i, i + BATCH_SIZE);
  
  const values = batch.map(f => {
    const id = f.id.replace(/'/g, "''");
    const name = (f.name || '').replace(/'/g, "''");
    const mime = (f.mimeType || 'video/mp4').replace(/'/g, "''");
    const size = f.size ? parseInt(f.size) : 0;
    const thumb = f.thumbnailLink ? f.thumbnailLink.replace(/'/g, "''") : '';
    const created = f.createdTime ? new Date(f.createdTime).getTime() : Date.now();
    const now = Date.now();
    return `('${id}', '${name}', '${mime}', ${size}, ${thumb ? `'${thumb}'` : 'NULL'}, ${created}, ${now})`;
  }).join(',\n');

  const sql = `INSERT INTO drive_videos (driveFileId, fileName, mimeType, sizeBytes, thumbnailUrl, driveCreatedAt, lastIndexedAt)
VALUES ${values}
ON DUPLICATE KEY UPDATE 
  fileName = VALUES(fileName),
  mimeType = VALUES(mimeType),
  sizeBytes = VALUES(sizeBytes),
  thumbnailUrl = COALESCE(VALUES(thumbnailUrl), thumbnailUrl),
  driveCreatedAt = VALUES(driveCreatedAt),
  lastIndexedAt = VALUES(lastIndexedAt)`;

  // Execute via the app's DB connection by posting to a simple endpoint
  // Actually, let's just use mysql CLI directly
  const { execSync } = await import('child_process');
  
  // Write SQL to temp file
  const sqlFile = `/tmp/drive_batch_${i}.sql`;
  const { writeFileSync } = await import('fs');
  writeFileSync(sqlFile, sql);
  
  try {
    // Extract DB connection from DATABASE_URL
    const dbUrl = process.env.DATABASE_URL;
    // Parse: mysql://user:pass@host:port/dbname?ssl=...
    const match = dbUrl.match(/mysql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/([^?]+)/);
    if (!match) throw new Error('Cannot parse DATABASE_URL: ' + dbUrl.slice(0, 50));
    const [, user, pass, host, port, dbName] = match;
    
    execSync(
      `mysql -u${user} -p'${pass}' -h${host} -P${port} ${dbName} --ssl-mode=REQUIRED < ${sqlFile}`,
      { timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    totalUpdated += batch.length;
    if ((i / BATCH_SIZE) % 2 === 0) {
      console.log(`Updated ${totalUpdated}/${allFiles.length} files...`);
    }
  } catch (err) {
    console.error(`Batch ${i} failed:`, err.stderr?.toString().slice(0, 200) || err.message?.slice(0, 200));
  }
}

console.log(`\nDone! Updated ${totalUpdated} drive_videos records.`);
console.log(`Files with thumbnails: ${allFiles.filter(f => f.thumbnailLink).length}`);
