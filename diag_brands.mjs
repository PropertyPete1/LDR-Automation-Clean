// Diagnose: what brands does getAllBrands() return and what networks do they have?
const token = process.env.METRICOOL_API_TOKEN;
const userId = process.env.METRICOOL_USER_ID;

const res = await fetch(`https://app.metricool.com/api/admin/simpleProfiles?userId=${userId}`, {
  headers: { 'X-Mc-Auth': token, 'Content-Type': 'application/json' }
});
const profiles = await res.json();

console.log(`Total profiles: ${profiles.length}\n`);

for (const p of profiles) {
  if (p.deleted || p.isDemo) continue;
  const label = p.label || 'unnamed';
  const networks = [];
  if (p.instagram) networks.push(`INSTAGRAM (${p.instagram})`);
  if (p.tiktok) networks.push(`TIKTOK (${p.tiktok})`);
  if (p.youtube) networks.push(`YOUTUBE (${p.youtube})`);
  if (p.linkedin || p.linkedinCompany) networks.push(`LINKEDIN (${p.linkedin || p.linkedinCompany})`);
  if (p.facebook || p.facebookPageId) networks.push(`FACEBOOK`);
  
  const hasIG = !!p.instagram;
  console.log(`Brand: ${label} (blogId: ${p.id})`);
  console.log(`  Networks: ${networks.join(', ') || 'NONE'}`);
  console.log(`  Has Instagram (required for reel posting): ${hasIG ? 'YES' : 'NO - EXCLUDED'}`);
  console.log(`  tiktokBusinessTokenExpiration: ${p.tiktokBusinessTokenExpiration || 'null'}`);
  console.log(`  linkedInTokenExpiration: ${p.linkedInTokenExpiration || 'null'}`);
  console.log('');
}

// Simulate what the code does
console.log('=== SIMULATION: What createScheduledPost would target ===');
const allowed = ["INSTAGRAM", "TIKTOK", "YOUTUBE"];
for (const p of profiles) {
  if (p.deleted || p.isDemo) continue;
  const label = p.label || 'unnamed';
  const networks = [];
  if (p.instagram) networks.push("INSTAGRAM");
  if (p.tiktok) networks.push("TIKTOK");
  if (p.youtube) networks.push("YOUTUBE");
  if (p.linkedin || p.linkedinCompany) networks.push("LINKEDIN");
  
  if (!networks.includes("INSTAGRAM")) {
    console.log(`SKIP ${label} - no Instagram`);
    continue;
  }
  
  const seen = new Set();
  const providers = networks
    .filter(n => allowed.includes(n) && !seen.has(n) && seen.add(n) !== undefined)
    .map(n => n.toLowerCase());
  
  console.log(`POST to ${label}: [${providers.join(', ')}]`);
}
