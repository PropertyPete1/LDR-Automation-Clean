// Check recent Metricool scheduled posts - try multiple endpoints
const token = process.env.METRICOOL_API_TOKEN;
const blogId = process.env.METRICOOL_BLOG_ID;
const userId = process.env.METRICOOL_USER_ID;

// Try the post history/published endpoint
const endpoints = [
  `/v2/scheduler/posts?blogId=${blogId}&userId=${userId}`,
  `/v2/scheduler/posts?blogId=${blogId}&userId=${userId}&status=PUBLISHED`,
  `/v2/scheduler/posts?blogId=${blogId}&userId=${userId}&status=PENDING`,
  `/v2/scheduler/posts?blogId=${blogId}&userId=${userId}&status=ERROR`,
  `/v2/post/list?blogId=${blogId}&userId=${userId}`,
  `/v2/post/scheduled?blogId=${blogId}&userId=${userId}`,
];

for (const ep of endpoints) {
  const res = await fetch(`https://app.metricool.com/api${ep}`, {
    headers: { 'X-Mc-Auth': token, 'Content-Type': 'application/json' }
  });
  const text = await res.text();
  const preview = text.slice(0, 200);
  console.log(`${res.status} ${ep.split('?')[0]}: ${preview}`);
  console.log('---');
}

// Also check the create post endpoint format to understand what we're sending
console.log('\n=== Check our publishNow code to understand what gets sent ===');
