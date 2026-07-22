/**
 * Investigate Reneé Pellat in FUB — pull her lead data, lastActivity, notes, emails
 * to understand why she wasn't routed to the pond and what context the bot had.
 */

const FUB_API_KEY = process.env.FUB_API_KEY;
if (!FUB_API_KEY) {
  console.error("Missing FUB_API_KEY");
  process.exit(1);
}

const FUB_BASE = "https://api.followupboss.com/v1";

async function fubGet(path) {
  const url = `${FUB_BASE}${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: "Basic " + Buffer.from(`${FUB_API_KEY}:`).toString("base64"),
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`FUB ${res.status}: ${body}`);
  }
  return res.json();
}

async function main() {
  // Search for "Rene" (covers Reneé, Rene, Renee)
  console.log("=== Searching FUB for 'Rene Pellat' ===\n");
  
  // Try searching by name
  const searchResults = await fubGet("/people?name=Rene%20Pellat&limit=10");
  let person = null;
  
  if (searchResults.people && searchResults.people.length > 0) {
    person = searchResults.people[0];
  } else {
    // Try broader search
    console.log("No exact match, trying broader search...");
    const broader = await fubGet("/people?name=Rene&limit=20");
    const matches = (broader.people || []).filter(p => 
      (p.lastName || "").toLowerCase().includes("pellat") ||
      (p.firstName || "").toLowerCase().includes("rene")
    );
    if (matches.length > 0) person = matches[0];
  }

  if (!person) {
    // Try email-based search
    console.log("Trying email search for renepellatjr...");
    const emailSearch = await fubGet("/people?email=renepellatjr&limit=5");
    if (emailSearch.people && emailSearch.people.length > 0) {
      person = emailSearch.people[0];
    }
  }

  if (!person) {
    console.log("Could not find Reneé in FUB. Trying all Rene* leads...");
    const allRene = await fubGet("/people?name=Rene&limit=50&includeNotes=true");
    console.log(`Found ${allRene.people?.length || 0} leads with 'Rene' in name:`);
    for (const p of (allRene.people || []).slice(0, 20)) {
      console.log(`  - ID:${p.id} ${p.firstName} ${p.lastName} | lastActivity: ${p.lastActivity} | stage: ${p.stage} | assigned: ${p.assignedUserId}`);
    }
    return;
  }

  console.log(`\n=== FOUND: ${person.firstName} ${person.lastName} (ID: ${person.id}) ===`);
  console.log(`Stage: ${person.stage}`);
  console.log(`lastActivity: ${person.lastActivity}`);
  console.log(`lastActivityAt: ${person.lastActivityAt}`);
  console.log(`assignedUserId: ${person.assignedUserId}`);
  console.log(`assignedPondId: ${person.assignedPondId}`);
  console.log(`textOptOut: ${person.textOptOut}`);
  console.log(`Tags: ${JSON.stringify(person.tags)}`);
  console.log(`Emails: ${JSON.stringify(person.emails)}`);
  console.log(`Phones: ${JSON.stringify(person.phones)}`);

  // Calculate days stale
  if (person.lastActivity) {
    const days = Math.floor((Date.now() - new Date(person.lastActivity).getTime()) / (1000 * 60 * 60 * 24));
    console.log(`\n⚠️  Days stale (from lastActivity): ${days} days`);
    console.log(`   Bot window is 3-19 days. This lead is ${days >= 19 ? "OUTSIDE" : "INSIDE"} the bot window.`);
  }

  // Fetch notes
  console.log("\n=== NOTES ===");
  const notesData = await fubGet(`/notes?personId=${person.id}&sort=-created&limit=20`);
  const notes = notesData.notes || [];
  console.log(`Total notes: ${notes.length}`);
  for (const note of notes) {
    console.log(`\n--- Note (${note.createdAt || note.created || "unknown date"}) ---`);
    console.log((note.body || "").substring(0, 500));
  }

  // Fetch emails
  console.log("\n\n=== EMAILS ===");
  const emailData = await fubGet(`/emails?personId=${person.id}&sort=-created&limit=10`);
  const emails = emailData.emails || [];
  console.log(`Total emails: ${emails.length}`);
  for (const email of emails) {
    const sentBy = email.relatedPeople?.find(rp => rp.personId === person.id);
    console.log(`\n--- Email (${email.date || "unknown"}) | Subject: ${email.subject || "N/A"} | sentByPerson: ${sentBy?.sentByPerson} ---`);
    if (email.bodyExcerpt) console.log(`  Excerpt: ${email.bodyExcerpt.substring(0, 200)}`);
  }

  // Fetch text messages
  console.log("\n\n=== TEXT MESSAGES ===");
  const textData = await fubGet(`/textMessages?personId=${person.id}&sort=-dateCreated&limit=10`);
  const texts = textData.textmessages || [];
  console.log(`Total texts: ${texts.length}`);
  for (const text of texts) {
    console.log(`\n--- Text (${text.sent || text.dateCreated || "unknown"}) | isIncoming: ${text.isIncoming} ---`);
    console.log(`  Message: ${(text.message || "").substring(0, 200)}`);
  }
}

main().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});
