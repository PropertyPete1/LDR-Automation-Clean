import 'dotenv/config';

const FUB_API_KEY = process.env.FUB_API_KEY;
const BASE = 'https://api.followupboss.com/v1';
const headers = {
  'Authorization': 'Basic ' + Buffer.from(FUB_API_KEY + ':').toString('base64'),
  'Content-Type': 'application/json',
};

// Search for Reneé Pellat
const searchUrl = `${BASE}/people?sort=created&limit=5&q=renepellatjr@gmail.com`;
const res = await fetch(searchUrl, { headers });
const data = await res.json();

if (data.people && data.people.length > 0) {
  const person = data.people[0];
  console.log("=== RENEÉ PELLAT CURRENT STATUS ===");
  console.log("Person ID:", person.id);
  console.log("Name:", person.firstName, person.lastName);
  console.log("Stage:", person.stage);
  console.log("assignedUserId:", person.assignedUserId);
  console.log("assignedPondId:", person.assignedPondId);
  console.log("assignedTo:", person.assignedTo);
  console.log("lastActivity:", person.lastActivity);
  
  // Also check what user ID 2 is (Peter?)
  const userRes = await fetch(`${BASE}/users/${person.assignedUserId}`, { headers });
  const userData = await userRes.json();
  console.log("\n=== ASSIGNED USER ===");
  console.log("User ID:", userData.id);
  console.log("Name:", userData.firstName, userData.lastName);
  console.log("Email:", userData.email);
  
  // Check the note that was left today
  const notesRes = await fetch(`${BASE}/notes?personId=${person.id}&sort=-created&limit=5`, { headers });
  const notesData = await notesRes.json();
  console.log("\n=== MOST RECENT NOTES ===");
  for (const note of (notesData.notes || []).slice(0, 3)) {
    console.log(`\n[${note.created}] by userId ${note.userId}:`);
    console.log(note.body?.substring(0, 300));
  }

  // Check if she's also on a pond
  if (person.assignedPondId) {
    const pondRes = await fetch(`${BASE}/ponds/${person.assignedPondId}`, { headers });
    const pondData = await pondRes.json();
    console.log("\n=== POND INFO ===");
    console.log("Pond ID:", pondData.id);
    console.log("Pond Name:", pondData.name);
  } else {
    console.log("\n=== NOT ON ANY POND ===");
  }
} else {
  console.log("Could not find Reneé");
}
