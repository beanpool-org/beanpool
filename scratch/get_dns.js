// Scratch script to fetch Cloudflare DNS records
import fs from 'fs';

// Load .env content manually
const envPath = '/Users/marty/projects/beanpool/.env';
const envContent = fs.readFileSync(envPath, 'utf8');
const env = {};
envContent.split('\n').forEach(line => {
  const match = line.match(/^\s*([\w.\-]+)\s*=\s*(.*)?\s*$/);
  if (match) {
    let value = match[2] || '';
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    env[match[1]] = value;
  }
});

const token = env.CF_API_TOKEN;
const zoneId = env.CF_ZONE_ID;
const email = env.CLOUDFLARE_EMAIL;
const apiKey = env.CLOUDFLARE_API_KEY;

console.log('Zone ID:', zoneId);
console.log('Has Token:', !!token);
console.log('Has API Key:', !!apiKey);

async function main() {
  const headers = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  } else {
    headers['X-Auth-Email'] = email;
    headers['X-Auth-Key'] = apiKey;
  }
  
  const url = `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?per_page=100`;
  const res = await fetch(url, { headers });
  const data = await res.json();
  
  if (!data.success) {
    console.error('Error fetching DNS records:', data.errors);
    return;
  }
  
  const records = data.result.map(r => ({
    id: r.id,
    type: r.type,
    name: r.name,
    content: r.content,
    proxied: r.proxied,
    ttl: r.ttl
  }));
  
  console.log(JSON.stringify(records, null, 2));
}

main().catch(console.error);
