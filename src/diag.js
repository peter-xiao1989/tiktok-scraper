const https = require('https');

const TOKEN      = process.env.TIKTOK_ACCESS_TOKEN;
const APP_ID     = process.env.TIKTOK_APP_ID;
const APP_SECRET = process.env.TIKTOK_APP_SECRET;
const BC_ID      = process.env.TIKTOK_BC_ID || '7623379731659948049';
const HOST       = 'business-api.tiktok.com';

function rawGet(path) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: HOST, path, method: 'GET',
        headers: { 'Access-Token': TOKEN, 'Content-Type': 'application/json' } },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d })); }
    );
    req.on('error', reject); req.end();
  });
}

async function probe(label, path) {
  process.stdout.write(`\n[${label}]\n`);
  const { status, body } = await rawGet(path);
  console.log(`HTTP ${status}`);
  try { console.log(JSON.stringify(JSON.parse(body), null, 2).slice(0, 1000)); }
  catch { console.log('(non-JSON):', body.slice(0, 300)); }
}

async function main() {
  if (!TOKEN) { console.error('TIKTOK_ACCESS_TOKEN required'); process.exit(1); }
  console.log(`TOKEN: ${TOKEN.slice(0, 8)}...  APP_ID: ${APP_ID || '(none)'}  BC_ID: ${BC_ID}`);

  // 1. oauth2/advertiser/get — should list all authorized advertisers
  if (APP_ID && APP_SECRET) {
    const qs = new URLSearchParams({ app_id: APP_ID, secret: APP_SECRET, access_token: TOKEN }).toString();
    await probe('oauth2/advertiser/get', `/open_api/v1.3/oauth2/advertiser/get/?${qs}`);
  }

  // 2. bc/advertiser/list
  await probe('bc/advertiser/list',
    `/open_api/v1.3/bc/advertiser/list/?bc_id=${BC_ID}&page=1&page_size=20`);

  // 3. advertiser/info with known IDs from token exchange (correct field: name not advertiser_name)
  const knownIds = ['7625853669648465921', '7625853669648564225'];
  const qs3 = new URLSearchParams({
    advertiser_ids: JSON.stringify(knownIds),
    fields: JSON.stringify(['name', 'timezone']),
  }).toString();
  await probe('advertiser/info (known IDs)', `/open_api/v1.3/advertiser/info/?${qs3}`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
