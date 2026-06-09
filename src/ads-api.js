/**
 * TikTok Marketing API v1.3 — daily ad report → Feishu Bitable (TT广告下载原表)
 *
 * Required env vars:
 *   TIKTOK_ACCESS_TOKEN  — OAuth access token from TikTok Marketing API
 *   TIKTOK_BC_ID         — Business Center ID (default: 7623379731659948049)
 *
 * Optional:
 *   TARGET_DATE          — YYYY-MM-DD override (applies to all accounts)
 *   FEISHU_APP_ID / FEISHU_APP_SECRET
 */

const https = require('https');

const BITABLE_APP   = 'HCXKb9qoDaiEmqsl4cocOnNPnpb';
const TABLE_ID      = 'tblBswHs4fJ1s0ID'; // TT广告下载原表
const FEISHU_APP_ID     = process.env.FEISHU_APP_ID     || 'cli_aa898a664d395cc2';
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || 'fOlixcmQNWlOBkrEAHagGdZUI5Fum3KX';
const TIKTOK_HOST       = 'business-api.tiktok.com';

// ─── Date helpers ─────────────────────────────────────────────────────────────

function yesterdayInOffset(offsetHours) {
  return new Date(Date.now() + offsetHours * 3600000 - 86400000).toISOString().slice(0, 10);
}

function parseOffsetHours(tz) {
  if (!tz) return 8;
  const m = tz.match(/UTC([+-]\d+)/i);
  if (m) return parseInt(m[1], 10);
  const named = {
    'Asia/Shanghai': 8, 'Asia/Hong_Kong': 8, 'Asia/Singapore': 8,
    'Asia/Tokyo': 9, 'Asia/Seoul': 9,
    'America/New_York': -5, 'America/Los_Angeles': -8,
    'Europe/London': 0, 'Europe/Berlin': 1,
  };
  return named[tz] ?? 8;
}

function tzLabel(offsetHours) {
  return `GMT${offsetHours >= 0 ? '+' : ''}${offsetHours}`;
}

// ─── TikTok API ───────────────────────────────────────────────────────────────

function tiktokGet(path, accessToken) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: TIKTOK_HOST, path, method: 'GET',
        headers: { 'Access-Token': accessToken, 'Content-Type': 'application/json' } },
      res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try { resolve(JSON.parse(d)); }
          catch (e) { reject(new Error(`TikTok API non-JSON (HTTP ${res.statusCode}): ${d.slice(0, 300)}`)); }
        });
      }
    );
    req.on('error', reject); req.end();
  });
}

async function resolveAdvertiserInfo(ids, accessToken) {
  const qs = new URLSearchParams({
    advertiser_ids: JSON.stringify(ids),
    fields: JSON.stringify(['advertiser_id', 'name', 'timezone']),
  }).toString();
  const r = await tiktokGet(`/open_api/v1.3/advertiser/info/?${qs}`, accessToken);
  if (r.code !== 0) return ids.map(id => ({ id, name: id, offsetHours: 8 }));
  const infoMap = {};
  for (const adv of r.data?.list || []) {
    infoMap[String(adv.advertiser_id)] = { name: adv.name, offsetHours: parseOffsetHours(adv.timezone) };
  }
  return ids.map(id => ({ id, name: infoMap[id]?.name || id, offsetHours: infoMap[id]?.offsetHours ?? 8 }));
}

async function getAdvertisers(bcId, accessToken) {
  const appId     = process.env.TIKTOK_APP_ID;
  const appSecret = process.env.TIKTOK_APP_SECRET;

  // 1. oauth2/advertiser/get — returns all advertisers that authorized this app
  if (appId && appSecret) {
    const qs = new URLSearchParams({ app_id: appId, secret: appSecret, access_token: accessToken }).toString();
    const r = await tiktokGet(`/open_api/v1.3/oauth2/advertiser/get/?${qs}`, accessToken);
    if (r.code === 0) {
      const list = r.data?.list || [];
      console.log(`  oauth2/advertiser/get → ${list.length} advertisers`);
      // response has advertiser_id + advertiser_name; enrich with timezone via advertiser/info
      const ids = list.map(a => String(a.advertiser_id));
      return resolveAdvertiserInfo(ids, accessToken);
    }
    console.warn(`[warn] oauth2/advertiser/get: code=${r.code} ${r.message}`);
  }

  // 2. BC advertiser list
  if (bcId) {
    try {
      const ids = [];
      let page = 1;
      while (true) {
        const qs = new URLSearchParams({ bc_id: bcId, page, page_size: 100 }).toString();
        const r = await tiktokGet(`/open_api/v1.3/bc/advertiser/list/?${qs}`, accessToken);
        if (r.code !== 0) throw new Error(`code=${r.code} ${r.message}`);
        ids.push(...(r.data?.list || []).map(a => String(a.advertiser_id)));
        if (!r.data?.page_info?.has_more) break;
        page++;
      }
      if (ids.length > 0) return resolveAdvertiserInfo(ids, accessToken);
    } catch (e) {
      console.warn(`[warn] bc/advertiser/list failed: ${e.message}`);
    }
  }

  // 3. Explicit IDs fallback
  const explicitIds = (process.env.TIKTOK_ADVERTISER_IDS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (explicitIds.length > 0) {
    console.log(`  Using explicit TIKTOK_ADVERTISER_IDS (${explicitIds.length})`);
    return resolveAdvertiserInfo(explicitIds, accessToken);
  }

  throw new Error('Cannot get advertiser list. Set TIKTOK_APP_ID+TIKTOK_APP_SECRET, or TIKTOK_ADVERTISER_IDS.');
}

async function getAdvertiserTimezones(advertisers) {
  // timezone already resolved in getAdvertisers via resolveAdvertiserInfo
  const map = {};
  for (const adv of advertisers) map[adv.id] = adv.offsetHours ?? 8;
  return map;
}

const DIMENSIONS = ['ad_id', 'stat_time_day'];
const METRICS = [
  'spend', 'cpm', 'ctr', 'cpc', 'impressions', 'clicks',
  'conversions', 'cost_per_conversion', 'real_time_roas',
  'app_install', 'cost_per_install', 'reach_cpm',
  'gross_impressions',         // 广告曝光事件总数 — verify on first run
  'engaged_view',              // 活跃度 — verify on first run
  'cost_per_engaged_view',     // 活跃度平均成本 — verify on first run
  'engaged_view_rate',         // 广告曝光事件率 — verify on first run
  'cost_per_gross_impressions',// 广告曝光事件平均成本 — verify on first run
  'total_engaged_view_value',  // 广告曝光总价值 — verify on first run
  'avg_engaged_view_value',    // 广告曝光事件平均价值 — verify on first run
];

async function fetchReport(advertiserId, date, accessToken) {
  const all = [];
  let page = 1;
  while (true) {
    const qs = new URLSearchParams({
      advertiser_id: advertiserId,
      report_type: 'BASIC',
      data_level: 'AUCTION_AD',
      dimensions: JSON.stringify(DIMENSIONS),
      metrics: JSON.stringify(METRICS),
      start_date: date,
      end_date: date,
      page_size: 1000,
      page,
      multi_adv_report_in_utc_time: false, // use each account's own timezone
    }).toString();
    const r = await tiktokGet(`/open_api/v1.3/report/integrated/get/?${qs}`, accessToken);
    if (r.code !== 0) throw new Error(`report adv=${advertiserId}: code=${r.code} ${r.message}`);
    all.push(...(r.data?.list || []));
    if (!r.data?.page_info?.has_more) break;
    page++;
  }
  return all;
}

// ─── Row mapping (32 fields = 31 data cols + 时区) ───────────────────────────

function num(v)  { const n = parseFloat(v); return isNaN(n) ? null : n; }
function str(v)  { return (v == null || v === '-') ? '' : String(v); }
function pct(v)  { const n = parseFloat(v); return isNaN(n) ? '' : (n * 100).toFixed(2) + '%'; }
function div(a, b) {
  const na = parseFloat(a), nb = parseFloat(b);
  return (!isNaN(na) && !isNaN(nb) && nb !== 0) ? parseFloat((na / nb).toFixed(4)) : null;
}

function mapRecord(row, advertiserName, tz) {
  const d = row.dimensions || {};
  const m = row.metrics    || {};
  const gi = m.gross_impressions;
  const ev = m.engaged_view;

  return {
    '系列名称':               str(d.campaign_name),              //  1
    '按天':                   str(d.stat_time_day),              //  2
    '消耗':                   num(m.spend),                      //  3
    '广告收入 ROAS (TikTok)': num(m.real_time_roas),             //  4
    '活跃度':                 num(ev),                           //  5
    '活跃度平均成本':          num(m.cost_per_engaged_view),      //  6
    '人均广告次数':            div(gi, ev),                       //  7 calculated
    '点击率（目标页面）':      pct(m.ctr),                        //  8
    '千次展示成本 (CPM)':     num(m.cpm),                        //  9
    '平均点击成本（目标页面）': num(m.cpc),                       // 10
    '创意素材名称':            str(d.ad_name),                   // 11
    '账户名称':               advertiserName,                    // 12
    '推广系列预算':            str(d.campaign_budget),           // 13
    '推广系列类型':            str(d.objective_type),            // 14
    '广告组名称':              str(d.adgroup_name),              // 15
    '广告位类型':              str(d.placement_type),            // 16
    '广告名称':               str(d.ad_name),                   // 17
    '广告文案':               str(d.ad_text),                   // 18
    '推广系列预算类型':        str(d.budget_mode || d.campaign_budget_mode), // 19
    '应用安装数':              num(m.app_install),               // 20
    '应用安装平均成本':        num(m.cost_per_install),          // 21
    '点击量（目标页面）':      num(m.clicks),                    // 22
    '展示量':                 num(m.impressions),               // 23
    '覆盖千人成本':            num(m.reach_cpm),                 // 24
    '转化量':                 num(m.conversions),               // 25
    '平均转化成本':            num(m.cost_per_conversion),       // 26
    '广告曝光事件率':          pct(m.engaged_view_rate),         // 27
    '广告曝光事件总数':        num(gi),                          // 28
    '广告曝光事件平均成本':    num(m.cost_per_gross_impressions),// 29 — verify field name
    '广告曝光总价值':          num(m.total_engaged_view_value),  // 30
    '广告曝光事件平均价值':    num(m.avg_engaged_view_value),    // 31
    '时区':                   tz,                               // 32
  };
}

// ─── Feishu Bitable ───────────────────────────────────────────────────────────

function feishuReq(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request({ hostname: 'open.feishu.cn', path, method, headers },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d))); });
    req.on('error', reject);
    if (data) req.write(data); req.end();
  });
}

async function getFeishuToken() {
  const r = await feishuReq('POST', '/open-apis/auth/v3/tenant_access_token/internal', '',
    { app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET });
  return r.tenant_access_token;
}

// Returns Set of "账户名称|按天" already in Bitable — dedup key
async function getExistingKeys(token) {
  const keys = new Set();
  let pageToken = '';
  do {
    const qs = `page_size=500${pageToken ? '&page_token=' + pageToken : ''}`;
    const r = await feishuReq('GET',
      `/open-apis/bitable/v1/apps/${BITABLE_APP}/tables/${TABLE_ID}/records?${qs}`, token);
    if (r.code !== 0) throw new Error(`fetchExisting: ${JSON.stringify(r)}`);
    for (const item of r.data?.items || []) {
      const f = item.fields;
      const name = Array.isArray(f['账户名称']) ? f['账户名称'][0]?.text : f['账户名称'];
      const date = Array.isArray(f['按天'])     ? f['按天'][0]?.text     : f['按天'];
      if (name && date) keys.add(`${name}|${date}`);
    }
    pageToken = r.data?.has_more ? r.data.page_token : '';
  } while (pageToken);
  return keys;
}

async function batchCreate(token, records) {
  const BATCH = 500;
  let written = 0;
  for (let i = 0; i < records.length; i += BATCH) {
    const chunk = records.slice(i, i + BATCH);
    // Remove null values so Bitable doesn't reject them
    const cleaned = chunk.map(fields => ({
      fields: Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== null && v !== ''))
    }));
    const r = await feishuReq('POST',
      `/open-apis/bitable/v1/apps/${BITABLE_APP}/tables/${TABLE_ID}/records/batch_create`,
      token, { records: cleaned });
    if (r.code !== 0) throw new Error(`batch_create: ${JSON.stringify(r)}`);
    written += chunk.length;
    process.stdout.write(`\r  written ${written}/${records.length}...`);
  }
  process.stdout.write('\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const accessToken = process.env.TIKTOK_ACCESS_TOKEN;
  if (!accessToken) { console.error('TIKTOK_ACCESS_TOKEN required'); process.exit(1); }
  const bcId = process.env.TIKTOK_BC_ID || '7623379731659948049';

  console.log('Loading existing Bitable records for dedup...');
  const feishuToken  = await getFeishuToken();
  const existingKeys = await getExistingKeys(feishuToken);
  console.log(`  ${existingKeys.size} existing records found`);

  console.log(`Fetching advertiser list from BC ${bcId}...`);
  const advertisers = await getAdvertisers(bcId, accessToken);
  console.log(`  ${advertisers.length} advertisers`);

  const tzMap = await getAdvertiserTimezones(advertisers);

  const allRecords = [];
  for (const adv of advertisers) {
    const offsetHours = tzMap[adv.id] ?? 8;
    const tz = tzLabel(offsetHours);
    const date = process.env.TARGET_DATE || yesterdayInOffset(offsetHours);
    const key  = `${adv.name}|${date}`;

    process.stdout.write(`  [${adv.name}] ${tz} ${date} — `);
    if (existingKeys.has(key)) { process.stdout.write('already exists, skipped\n'); continue; }

    const rows = await fetchReport(adv.id, date, accessToken);
    process.stdout.write(`${rows.length} rows\n`);
    allRecords.push(...rows.map(row => mapRecord(row, adv.name, tz)));
  }

  if (!allRecords.length) { console.log('Nothing to write.'); return; }

  console.log(`Writing ${allRecords.length} records to Bitable...`);
  await batchCreate(feishuToken, allRecords);
  console.log('Done.');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
