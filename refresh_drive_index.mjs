/**
 * Refresh Drive index via gws CLI - paginate all videos and update thumbnailUrl in drive_videos table.
 */
import { execSync } from 'child_process';
import { writeFileSync } from 'fs';

const FOLDER_ID = '16mNnK1avek0LUljjFPZ5iNxON2OJZod7';
const PAGE_SIZE = 100;
const CWD = '/home/ubuntu/ig_repost_dashboard';

let allFiles = [];
let nextPageToken = null;
let page = 0;

while (true) {
  page++;
  let paramsObj = {
    q: `mimeType contains 'video/' and '${FOLDER_ID}' in parents`,
    pageSize: PAGE_SIZE,
    fields: "files(id,name,mimeType,size,thumbnailLink,createdTime),nextPageToken",
  };
  if (nextPageToken) paramsObj.pageToken = nextPageToken;

  // Write params to a temp file to avoid shell escaping issues
  const paramsFile = `/tmp/gws_params_page${page}.json`;
  writeFileSync(paramsFile, JSON.stringify(paramsObj));
  
  // Read from file and pass as argument
  const paramsJson = JSON.stringify(paramsObj);
  // Use double quotes for the outer shell, escape inner quotes
  const cmd = `gws drive files list --params '${paramsJson.replace(/'/g, "'\\''")}'`;
  
  console.log(`[Page ${page}] Fetching...`);
  
  let result;
  try {
    const stdout = execSync(cmd, { 
      timeout: 60000, 
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: CWD,
    }).toString();
    result = JSON.parse(stdout);
  } catch (err) {
    // Try alternative approach with env var
    console.log(`[Page ${page}] Trying alternative approach...`);
    try {
      const stdout = execSync(
        `node -e "const {execSync}=require('child_process');const p=${JSON.stringify(JSON.stringify(paramsObj))};const r=execSync('gws drive files list --params '+JSON.stringify(p),{cwd:'${CWD}'}).toString();process.stdout.write(r);"`,
        { timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] }
      ).toString();
      result = JSON.parse(stdout);
    } catch (err2) {
      console.error(`[Page ${page}] Both approaches failed:`, err2.message?.slice(0, 200));
      break;
    }
  }

  const files = result.files || [];
  allFiles.push(...files);
  console.log(`[Page ${page}] Got ${files.length} files (total: ${allFiles.length})`);

  nextPageToken = result.nextPageToken;
  if (!nextPageToken) break;
}

console.log(`\nTotal Drive videos found: ${allFiles.length}`);
const withThumb = allFiles.filter(f => f.thumbnailLink);
console.log(`With thumbnails: ${withThumb.length}`);
console.log(`Without thumbnails: ${allFiles.length - withThumb.length}`);

writeFileSync('/tmp/drive_files_fresh.json', JSON.stringify(allFiles, null, 2));
console.log(`Saved to /tmp/drive_files_fresh.json`);
