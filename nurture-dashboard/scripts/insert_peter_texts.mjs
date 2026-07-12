/**
 * One-time script: retroactively insert Peter's 13 texts from June 12, 2026
 * into the sms_sent_today table.
 *
 * These were sent before the DB tracking was deployed, so they are missing
 * from the leaderboard. We use placeholder personIds (90001-90013) since
 * the actual FUB lead IDs are unknown for these pre-deployment texts.
 *
 * Run: node scripts/insert_peter_texts.mjs
 */

import mysql from "mysql2/promise";

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

// Parse mysql:// URL into connection config
const url = new URL(DB_URL);
const sslParam = url.searchParams.get("ssl");
const sslConfig = sslParam ? JSON.parse(decodeURIComponent(sslParam)) : undefined;

const conn = await mysql.createConnection({
  host: url.hostname,
  port: Number(url.port) || 3306,
  user: url.username,
  password: url.password,
  database: url.pathname.replace("/", ""),
  ssl: sslConfig,
});

const SENT_DATE = "2026-06-12";
const AGENT_NAME = "Peter";

// Check for existing Peter entries on this date to avoid duplicates
const [existing] = await conn.execute(
  "SELECT COUNT(*) as cnt FROM sms_sent_today WHERE agent_name = ? AND sent_date = ?",
  [AGENT_NAME, SENT_DATE]
);
const existingCount = existing[0].cnt;
console.log(`Existing Peter entries for ${SENT_DATE}: ${existingCount}`);

if (existingCount >= 13) {
  console.log("Peter already has 13+ entries for today — skipping insert to avoid duplicates.");
  await conn.end();
  process.exit(0);
}

const toInsert = 13 - existingCount;
console.log(`Inserting ${toInsert} retroactive text records for Peter...`);

// Use placeholder personIds starting at 90001 (pre-deployment texts, IDs unknown)
// These are unique enough to not collide with real FUB IDs (FUB IDs are in the millions)
const rows = [];
for (let i = 0; i < toInsert; i++) {
  rows.push([90001 + existingCount + i, AGENT_NAME, SENT_DATE]);
}

await conn.query(
  "INSERT INTO sms_sent_today (person_id, agent_name, sent_date) VALUES ?",
  [rows]
);

console.log(`✅ Inserted ${toInsert} rows for Peter on ${SENT_DATE}`);

// Verify final count
const [final] = await conn.execute(
  "SELECT COUNT(*) as cnt FROM sms_sent_today WHERE agent_name = ? AND sent_date = ?",
  [AGENT_NAME, SENT_DATE]
);
console.log(`Final Peter count for ${SENT_DATE}: ${final[0].cnt}`);

// Show full leaderboard
const [leaderboard] = await conn.execute(
  "SELECT agent_name, COUNT(*) as texts FROM sms_sent_today WHERE sent_date = ? GROUP BY agent_name ORDER BY texts DESC",
  [SENT_DATE]
);
console.log("\nToday's leaderboard:");
for (const row of leaderboard) {
  console.log(`  ${row.agent_name}: ${row.texts} texts`);
}

await conn.end();
