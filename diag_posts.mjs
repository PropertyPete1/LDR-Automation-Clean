import mysql from 'mysql2/promise';

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// Check daily picks for last 3 days
const [picks] = await conn.query(`
  SELECT id, pickDate, city, status, videoId, 
         driveVideoUrl IS NOT NULL as hasDriveUrl
  FROM daily_picks 
  WHERE pickDate >= DATE_SUB(CURDATE(), INTERVAL 3 DAY) 
  ORDER BY pickDate DESC, city
`);
console.log('=== DAILY PICKS (last 3 days) ===');
for (const p of picks) {
  console.log(`  ${p.pickDate} | ${p.city} | status: ${p.status} | videoId: ${p.videoId} | hasDrive: ${p.hasDriveUrl}`);
}

// Check reposts for last 3 days (columns: id, videoId, postId, city, status, confirmedAt, postedAt, igMediaId, publishError)
const [reposts] = await conn.query(`
  SELECT id, videoId, city, status, postedAt, publishError, postId, igMediaId
  FROM reposts 
  WHERE confirmedAt >= DATE_SUB(NOW(), INTERVAL 3 DAY) 
  ORDER BY confirmedAt DESC
`);
console.log('\n=== REPOSTS (last 3 days) ===');
for (const r of reposts) {
  const st = r.status === 'posted' ? `POSTED at ${r.postedAt}` : r.status === 'failed' ? `FAILED: ${r.publishError}` : 'CONFIRMED (pending)';
  console.log(`  id:${r.id} | video:${r.videoId} | ${r.city} | ${st} | metricoolId: ${r.postId || 'none'}`);
}

// Check for duplicates
const [dupes] = await conn.query(`
  SELECT videoId, city, COUNT(*) as cnt, GROUP_CONCAT(postedAt) as times
  FROM reposts 
  WHERE status = 'posted' AND confirmedAt >= DATE_SUB(NOW(), INTERVAL 7 DAY)
  GROUP BY videoId, city
  HAVING COUNT(*) > 1
`);
console.log('\n=== DUPLICATE POSTS (same video+city posted more than once in 7 days) ===');
if (dupes.length === 0) console.log('  None found');
else for (const d of dupes) console.log(`  ⚠️ Video ${d.videoId} (${d.city}) posted ${d.cnt} times: ${d.times}`);

// Check today's status specifically
console.log('\n=== TODAY (Jul 6) STATUS ===');
const todayPicks = picks.filter(p => String(p.pickDate).includes('2026-07-06'));
for (const p of todayPicks) {
  console.log(`  ${p.city}: ${p.status} (videoId: ${p.videoId}, hasDrive: ${p.hasDriveUrl})`);
}
console.log('\n  SA failed = Drive disconnected this morning (the 8:06 AM alert)');
console.log('  Austin/Dallas confirmed but NOT posted yet = posting agents havent fired yet (2/3/4 PM)');

await conn.end();
process.exit(0);
