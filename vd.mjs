import 'dotenv/config';
import mysql from 'mysql2/promise';
const conn = await mysql.createConnection({ uri: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// 1) Which Dallas videos were posted in last 30 days (no-repeat eligibility)?
const [reposts] = await conn.query(
  "SELECT r.videoId, v.city, r.postedAt FROM reposts r JOIN videos v ON v.id=r.videoId WHERE v.city='dallas' AND r.postedAt > (UNIX_TIMESTAMP()*1000 - 30*86400000)"
);
console.log('Dallas reposts in last 30d:', reposts.length);

// 2) Top eligible Dallas pick (highest views, not reposted in 30d)
const [top] = await conn.query(
  `SELECT id, postId, views, LEFT(caption,40) cap FROM videos
   WHERE city='dallas'
   AND id NOT IN (SELECT videoId FROM reposts WHERE postedAt > (UNIX_TIMESTAMP()*1000 - 30*86400000))
   ORDER BY views DESC LIMIT 1`
);
console.log('Top eligible Dallas pick:', top[0] || 'NONE');
await conn.end();
