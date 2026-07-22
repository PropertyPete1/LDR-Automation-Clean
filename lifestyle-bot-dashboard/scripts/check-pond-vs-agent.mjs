import 'dotenv/config';

const FUB_API_KEY = process.env.FUB_API_KEY;
const BASE = 'https://api.followupboss.com/v1';
const headers = {
  'Authorization': 'Basic ' + Buffer.from(FUB_API_KEY + ':').toString('base64'),
  'Content-Type': 'application/json',
};

// Get leads from Lead Pond (pond ID 2) to see if they all have assignedUserId too
console.log("=== LEADS ON LEAD POND (ID 2) - first 10 ===");
const pondRes = await fetch(`${BASE}/people?assignedPondId[]=2&limit=10`, { headers });
const pondData = await pondRes.json();

for (const p of (pondData.people || []).slice(0, 10)) {
  console.log(`  ${p.firstName} ${p.lastName} (ID ${p.id}) | assignedUserId: ${p.assignedUserId} | assignedTo: ${p.assignedTo} | assignedPondId: ${p.assignedPondId} | stage: ${p.stage}`);
}

console.log("\n=== LEADS ASSIGNED TO PETER (userId 2) - first 10 ===");
const peterRes = await fetch(`${BASE}/people?assignedUserId[]=2&limit=10&sort=-lastActivity`, { headers });
const peterData = await peterRes.json();

for (const p of (peterData.people || []).slice(0, 10)) {
  console.log(`  ${p.firstName} ${p.lastName} (ID ${p.id}) | assignedUserId: ${p.assignedUserId} | assignedTo: ${p.assignedTo} | assignedPondId: ${p.assignedPondId} | stage: ${p.stage}`);
}

// Check: does FUB API allow filtering by assignedPondId = null?
console.log("\n=== PETER'S LEADS WITH NO POND (assignedPondId should be null) ===");
// Try fetching Peter's leads and checking which ones have no pond
let noPondCount = 0;
let hasPondCount = 0;
for (const p of (peterData.people || [])) {
  if (p.assignedPondId) hasPondCount++;
  else noPondCount++;
}
console.log(`  Of Peter's first 10 leads: ${noPondCount} have NO pond, ${hasPondCount} HAVE a pond assigned`);
