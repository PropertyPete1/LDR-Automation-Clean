// Check the actual status of recent Metricool posts to see if TikTok/YouTube failed
const token = process.env.METRICOOL_API_TOKEN;
const userId = process.env.METRICOOL_USER_ID;
const blogId = process.env.METRICOOL_BLOG_ID;

const headers = { 'X-Mc-Auth': token, 'Content-Type': 'application/json' };

// Try to get scheduled/published posts from Metricool
// The scheduler endpoint shows post status per network
const endpoints = [
  `/v2/scheduler/posts?blogId=${blogId}&userId=${userId}&limit=10`,
  `/v2/scheduler/posts?blogId=${blogId}&userId=${userId}&status=PUBLISHED&limit=10`,
  `/v2/scheduler/posts?blogId=${blogId}&userId=${userId}&status=ERROR&limit=10`,
];

for (const ep of endpoints) {
  console.log(`\n=== GET ${ep} ===`);
  const res = await fetch(`https://app.metricool.com/api${ep}`, { headers });
  if (!res.ok) {
    console.log(`  HTTP ${res.status}: ${await res.text()}`);
    continue;
  }
  const data = await res.json();
  if (Array.isArray(data)) {
    console.log(`  ${data.length} posts found`);
    for (const post of data.slice(0, 5)) {
      console.log(`  Post ${post.id}: status=${post.status}, date=${post.publicationDate?.dateTime}`);
      if (post.providers) {
        for (const prov of post.providers) {
          console.log(`    → ${prov.network}: status=${prov.status || prov.publishStatus || 'unknown'}, error=${prov.error || prov.publishError || 'none'}`);
        }
      }
      if (post.networks) {
        for (const net of post.networks) {
          console.log(`    → ${net.network}: status=${net.status || 'unknown'}, error=${net.error || 'none'}`);
        }
      }
    }
  } else if (data.content) {
    console.log(`  ${data.content?.length || 0} posts in content`);
    for (const post of (data.content || []).slice(0, 5)) {
      console.log(`  Post ${post.id}: status=${post.status}, date=${post.publicationDate?.dateTime || post.date}`);
      if (post.providers) {
        for (const prov of post.providers) {
          console.log(`    → ${prov.network}: status=${prov.status || prov.publishStatus || 'unknown'}, error=${prov.error || prov.publishError || 'none'}`);
        }
      }
    }
  } else {
    console.log(`  Response:`, JSON.stringify(data).slice(0, 500));
  }
}

// Also try the planner endpoint which might show per-network status
console.log('\n=== Trying planner/posts endpoint ===');
const plannerRes = await fetch(`https://app.metricool.com/api/v2/planner/posts?blogId=${blogId}&userId=${userId}&startDate=2026-07-04&endDate=2026-07-07`, { headers });
if (plannerRes.ok) {
  const plannerData = await plannerRes.json();
  const posts = Array.isArray(plannerData) ? plannerData : plannerData.content || plannerData.data || [];
  console.log(`  ${posts.length} planner posts found`);
  for (const post of posts.slice(0, 10)) {
    console.log(`  Post ${post.id}: ${post.status} | ${post.publicationDate?.dateTime || post.date}`);
    const provs = post.providers || post.networks || [];
    for (const p of provs) {
      console.log(`    → ${p.network || p.type}: ${p.status || p.publishStatus || '?'} ${p.error || p.publishError || ''}`);
    }
  }
} else {
  console.log(`  HTTP ${plannerRes.status}`);
}

process.exit(0);
