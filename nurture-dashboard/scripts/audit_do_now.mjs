/**
 * audit_do_now.mjs
 * Queries FUB directly for every roster agent and prints:
 *   - Total personal leads
 *   - Stale 14+ days (do_now raw)
 *   - Stale 14+ days in pond (to subtract)
 *   - Final do_now (what dashboard should show)
 *   - Hot Prospect count
 *
 * Run: node scripts/audit_do_now.mjs
 */
import { config } from "dotenv";
config({ path: ".env" });

const FUB_API_KEY = process.env.FUB_API_KEY;
if (!FUB_API_KEY) { console.error("FUB_API_KEY not set"); process.exit(1); }

const BASE = "https://api.followupboss.com/v1";
const creds = Buffer.from(`${FUB_API_KEY}:`).toString("base64");
const headers = { Accept: "application/json", Authorization: `Basic ${creds}` };

async function fubGet(path) {
  const res = await fetch(`${BASE}${path}`, { headers });
  if (!res.ok) throw new Error(`FUB ${path} → ${res.status}`);
  return res.json();
}

// Roster agents (same list as dashboardData.ts)
const ROSTER_AGENTS = [
  "Peter Allen", "Stefanie", "Steven", "Tiffany", "Abby", "Irma", "Laila"
];

// Cutoff: 14 days ago
const cutoff14 = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)
  .toISOString().split("T")[0] + "T00:00:00Z";

console.log(`\nFUB Do-Now Audit — ${new Date().toLocaleString("en-US", { timeZone: "America/Chicago" })} CT`);
console.log(`Cutoff (14 days ago): ${cutoff14}\n`);

// 1. Fetch all users — build lookup by BOTH full name and firstName
const usersData = await fubGet("/users?limit=50");
const nameToId = {};
for (const u of usersData.users || []) {
  if (u.name) nameToId[u.name.toLowerCase()] = Number(u.id);
  if (u.firstName) nameToId[u.firstName.toLowerCase()] = Number(u.id);
}

// 2. Fetch pond ID
let pondId = null;
try {
  const pondsData = await fubGet("/ponds?limit=50");
  const ponds = pondsData.ponds || [];
  if (ponds.length > 0) {
    pondId = Number(ponds[0].id);
    console.log(`Lead Pond ID: ${pondId} (${ponds[0].name || "unnamed"})\n`);
  }
} catch { console.log("Could not fetch ponds\n"); }

// 3. Per-agent audit
const rows = [];
for (const agentName of ROSTER_AGENTS) {
  // Try full name first, then first word of the roster name
  const uid = nameToId[agentName.toLowerCase()] ||
              nameToId[agentName.split(" ")[0].toLowerCase()];
  if (!uid) {
    rows.push({ agent: agentName, uid: "NOT FOUND", total: "-", doNowRaw: "-", doNowPond: "-", doNow: "-", hot: "-" });
    continue;
  }

  const [totalRes, doNowAllRes, hotRes] = await Promise.all([
    fubGet(`/people?limit=1&assignedUserId=${uid}`),
    fubGet(`/people?limit=1&assignedUserId=${uid}&lastActivityBefore=${cutoff14}`),
    fubGet(`/people?limit=1&assignedUserId=${uid}&stage=Hot%20Prospect`),
  ]);

  const totalAll = totalRes._metadata?.total ?? 0;
  const doNowAll = doNowAllRes._metadata?.total ?? 0;
  const hotAll = hotRes._metadata?.total ?? 0;

  let inPond = 0, doNowInPond = 0, hotInPond = 0;
  if (pondId) {
    const [pondRes, doNowPondRes, hotPondRes] = await Promise.all([
      fubGet(`/people?limit=1&assignedUserId=${uid}&assignedPondId=${pondId}`),
      fubGet(`/people?limit=1&assignedUserId=${uid}&assignedPondId=${pondId}&lastActivityBefore=${cutoff14}`),
      fubGet(`/people?limit=1&assignedUserId=${uid}&assignedPondId=${pondId}&stage=Hot%20Prospect`),
    ]);
    inPond = pondRes._metadata?.total ?? 0;
    doNowInPond = doNowPondRes._metadata?.total ?? 0;
    hotInPond = hotPondRes._metadata?.total ?? 0;
  }

  const total = Math.max(0, totalAll - inPond);
  const doNow = Math.max(0, doNowAll - doNowInPond);
  const hot = Math.max(0, hotAll - hotInPond);
  const pipeline = Math.max(0, total - doNow - hot);

  rows.push({
    agent: agentName,
    uid,
    totalAll,
    inPond,
    total,
    doNowAll,
    doNowInPond,
    doNow,
    hot,
    pipeline,
  });

  // Small delay to avoid rate limiting
  await new Promise(r => setTimeout(r, 500));
}

// 4. Print results table
console.log("Agent            | UID   | TotalAll | InPond | Personal | StaleAll | StalePond | DoNow | Hot | Pipeline");
console.log("-----------------|-------|----------|--------|----------|----------|-----------|-------|-----|----------");
for (const r of rows) {
  if (r.uid === "NOT FOUND") {
    console.log(`${r.agent.padEnd(16)} | NOT FOUND IN FUB`);
    continue;
  }
  console.log(
    `${r.agent.padEnd(16)} | ${String(r.uid).padEnd(5)} | ${String(r.totalAll).padEnd(8)} | ${String(r.inPond).padEnd(6)} | ${String(r.total).padEnd(8)} | ${String(r.doNowAll).padEnd(8)} | ${String(r.doNowInPond).padEnd(9)} | ${String(r.doNow).padEnd(5)} | ${String(r.hot).padEnd(3)} | ${r.pipeline}`
  );
}
console.log("\nDone.\n");
