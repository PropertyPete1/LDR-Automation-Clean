// Look up Jason in FUB users list
const FUB_API_KEY = process.env.FUB_API_KEY;
const BASE = "https://api.followupboss.com/v1";

async function main() {
  // Get all users from FUB
  const res = await fetch(`${BASE}/users`, {
    headers: {
      "Authorization": "Basic " + Buffer.from(`${FUB_API_KEY}:x`).toString("base64"),
      "Content-Type": "application/json"
    }
  });
  
  if (!res.ok) {
    console.error("FUB API error:", res.status, await res.text());
    return;
  }
  
  const data = await res.json();
  const users = data.users || [];
  
  // Find Jason
  const jasons = users.filter(u => 
    u.firstName?.toLowerCase().includes("jason") || 
    u.lastName?.toLowerCase().includes("jason") ||
    u.name?.toLowerCase().includes("jason")
  );
  
  if (jasons.length === 0) {
    console.log("No user named 'Jason' found. Here are all users:");
    users.forEach(u => {
      console.log(`  ID: ${u.id} | Name: ${u.firstName} ${u.lastName} | Email: ${u.email} | Role: ${u.role} | Status: ${u.status}`);
    });
  } else {
    console.log(`Found ${jasons.length} user(s) matching 'Jason':\n`);
    jasons.forEach(u => {
      console.log(`  ID: ${u.id}`);
      console.log(`  Name: ${u.firstName} ${u.lastName}`);
      console.log(`  Email: ${u.email}`);
      console.log(`  Role: ${u.role}`);
      console.log(`  Status: ${u.status}`);
      console.log(`  Teams: ${JSON.stringify(u.teams || [])}`);
      console.log(`  Created: ${u.created}`);
      console.log("");
    });
  }
}

main().catch(console.error);
