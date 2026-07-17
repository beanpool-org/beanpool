import fs from 'fs';

// Load .env content
const envPath = '/Users/marty/projects/beanpool/.env';
const envContent = fs.readFileSync(envPath, 'utf8');
const env = {};
envContent.split('\n').forEach(line => {
  const match = line.match(/^\s*([\w.\-]+)\s*=\s*(.*)?\s*$/);
  if (match) {
    let value = match[2] || '';
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    env[match[1]] = value;
  }
});

const token = env.CF_API_TOKEN;
const zoneId = env.CF_ZONE_ID;
const email = env.CLOUDFLARE_EMAIL;
const apiKey = env.CLOUDFLARE_API_KEY;

async function main() {
  const headers = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  } else {
    headers['X-Auth-Email'] = email;
    headers['X-Auth-Key'] = apiKey;
  }
  
  const url = `https://api.cloudflare.com/client/v4/zones/${zoneId}/load_balancers`;
  const res = await fetch(url, { headers });
  const data = await res.json();
  
  console.log('Load Balancer Response:', JSON.stringify(data, null, 2));
}

main().catch(console.error);
