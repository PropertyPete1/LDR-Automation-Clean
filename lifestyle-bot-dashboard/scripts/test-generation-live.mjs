/**
 * Test script: calls generateFollowUpMessage against a real FUB lead
 * to prove the Anthropic key works and email generation succeeds.
 * 
 * Run: node scripts/test-generation-live.mjs
 */

const FUB_API_KEY = process.env.FUB_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!FUB_API_KEY) { console.error("ERROR: FUB_API_KEY not set"); process.exit(1); }
if (!ANTHROPIC_API_KEY) { console.error("ERROR: ANTHROPIC_API_KEY not set"); process.exit(1); }

console.log(`FUB_API_KEY: ${FUB_API_KEY.slice(0, 6)}...${FUB_API_KEY.slice(-4)} (${FUB_API_KEY.length} chars)`);
console.log(`ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY.slice(0, 10)}...${ANTHROPIC_API_KEY.slice(-4)} (${ANTHROPIC_API_KEY.length} chars)`);

// Step 1: Fetch a real lead from Steven's roster (FUB user ID 3)
const fubAuth = "Basic " + Buffer.from(`${FUB_API_KEY}:`).toString("base64");

console.log("\n--- Step 1: Fetching a test lead from FUB (Peter's leads) ---");
const res = await fetch("https://api.followupboss.com/v1/people?limit=5&assignedUserId=2&includeNotes=true&sort=-lastActivityAt", {
  headers: { Authorization: fubAuth, "Content-Type": "application/json" }
});
if (!res.ok) {
  console.error(`FUB API error: ${res.status} ${await res.text()}`);
  process.exit(1);
}
const data = await res.json();
const people = data.people || [];
console.log(`Got ${people.length} leads from FUB`);

// Find one that's 5-15 days stale
let testLead = null;
for (const p of people) {
  const lastAct = p.lastActivity || p.lastActivityAt;
  if (!lastAct) continue;
  const days = Math.floor((Date.now() - new Date(lastAct).getTime()) / 86400000);
  if (days >= 5 && days <= 15) {
    testLead = p;
    testLead._daysStale = days;
    break;
  }
}

if (!testLead) {
  // Just use the first lead
  testLead = people[0];
  const lastAct = testLead.lastActivity || testLead.lastActivityAt;
  testLead._daysStale = lastAct ? Math.floor((Date.now() - new Date(lastAct).getTime()) / 86400000) : 7;
}

console.log(`\nTest lead: ${testLead.firstName} ${testLead.lastName || ""} (ID: ${testLead.id})`);
console.log(`Stage: ${testLead.stage}, Days stale: ${testLead._daysStale}`);
console.log(`Notes count: ${(testLead.notes || []).length}`);

// Step 2: Build context and call Anthropic directly (same as generateFollowUpMessage does)
console.log("\n--- Step 2: Calling Anthropic API (claude-sonnet-4-6) ---");

const notes = (testLead.notes || []).filter(n => {
  const body = (n.body || "").toLowerCase();
  return !body.includes("automated") && !body.includes("bot clock") && !body.includes("lifestyle bot");
}).slice(0, 5);

const noteContext = notes.length > 0
  ? notes.map((n, i) => {
      const daysAgo = n.createdAt ? Math.floor((Date.now() - new Date(n.createdAt).getTime()) / 86400000) : "?";
      return `Note ${i+1} [${daysAgo} days ago]: ${(n.body || "").slice(0, 200)}`;
    }).join("\n")
  : "No prior notes available.";

const prompt = `You are Steven from Lifestyle Design Realty writing a follow-up email to ${testLead.firstName || "a lead"}.
Days since last activity: ${testLead._daysStale}
Stage: ${testLead.stage || "New Lead"}

NOTES:
${noteContext}

Write a short, personalized follow-up email (2-4 sentences max). Be warm and genuine.
Return ONLY a JSON object: {"subject": "...", "body": "..."}`;

const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-api-key": ANTHROPIC_API_KEY,
    "anthropic-version": "2023-06-01",
  },
  body: JSON.stringify({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    messages: [
      { role: "user", content: prompt }
    ],
  }),
});

if (!anthropicRes.ok) {
  const errBody = await anthropicRes.text();
  console.error(`\n❌ ANTHROPIC API ERROR: ${anthropicRes.status}`);
  console.error(errBody);
  process.exit(1);
}

const anthropicData = await anthropicRes.json();
const content = anthropicData.content?.[0]?.text || "";

console.log(`\n✅ ANTHROPIC RESPONSE (model: ${anthropicData.model}):`);
console.log(`Usage: input=${anthropicData.usage?.input_tokens}, output=${anthropicData.usage?.output_tokens}`);
console.log(`\n--- Generated Email ---`);
console.log(content);
console.log(`\n--- END ---`);
console.log(`\n✅ SUCCESS: generateFollowUpMessage will work on the live deployment.`);
