/**
 * TikTok Marketing API v1.3 — realtime today's data → Bitable 每日实时投放数据
 *
 * Runs every 2 hours. Clears the table, then writes fresh today's data.
 *
 * Required env vars:
 *   TIKTOK_ACCESS_TOKEN
 *   TIKTOK_BC_ID  (default: 7623379731659948049)
 */

const https = require('https');

const BITABLE_APP   = 'HCXKb9qoDaiEmqsl4cocOnNPnpb';
const TABLE_ID      = 'tbl0iG0tQgVeC1dA'; // 每日实时投放数据
const FEISHU_APP_ID     = process.env.FEISHU_APP_ID     || 'cli_aa898a664d395cc2';
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || 'fOlixcmQNWlOBkrEAHagGdZUI5Fum3KX';
const TIKTOK_HOST       = 'business-api.tiktok.com';

// ─── Date helpers ─────────────────────────────────────────────────────────────

function todayInOffset(offsetHours) {
  return new Date(Date.now() + offsetHours * 3600000).toISOString().slice(0, 10);
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

function tzLabel(h) { return `GMT${h >= 0 ? '+' : ''}${h}`; }

function nowBeijing() {
  return new Date(Date.now() + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
}

// ─── TikTok API ───────────────────────────────────────────────────────────────

function tiktokGet(path, token) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: TIKTOK_HOST, path, method: 'GET',
        headers: { 'Access-Token': token, 'Content-Type': 'application/json' } },
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

async function getAdvertisers(bcId, accessToken) {
  const explicitIds = (process.env.TIKTOK_ADVERTISER_IDS || '')
    .split(',').map(s => s.trim()).filter(Boolean);

  if (explicitIds.length > 0) {
    console.log(`  Using explicit advertiser IDs (${explicitIds.length})`);
    const qs = new URLSearchParams({
      advertiser_ids: JSON.stringify(explicitIds),
      fields: JSON.stringify(['advertiser_name']),
    }).toString();
    const r = await tiktokGet(`/open_api/v1.3/advertiser/info/?${qs}`, accessToken);
    if (r.code !== 0) {
      console.warn(`[warn] advertiser/info for names failed: ${r.message}. Using IDs as names.`);
      return explicitIds.map(id => ({ id, name: id }));
    }
    const nameMap = {};
    for (const adv of r.data?.list || []) nameMap[String(adv.advertiser_id)] = adv.advertiser_name;
    return explicitIds.map(id => ({ id, name: nameMap[id] || id }));
  }

  // BC API fallback
  const list = [];
  let page = 1;
  while (true) {
    const qs = new URLSearchParams({ bc_id: bcId, page, page_size: 100 }).toString();
    const r = await tiktokGet(`/open_api/v1.3/bc/advertiser/list/?${qs}`, accessToken);
    if (r.code !== 0) throw new Error(`bc/advertiser/list: code=${r.code} ${r.message}`);
    list.push(...(r.data?.list || []).map(a => ({ id: String(a.advertiser_id), name: a.advertiser_name })));
    if (!r.data?.page_info?.has_more) break;
    page++;
  }
  return list;
}

async function getAdvertiserTimezones(advertisers, accessToken) {
  const qs = new URLSearchParams({
    advertiser_ids: JSON.stringify(advertisers.map(a => a.id)),
    fields: JSON.stringify(['timezone']),
  }).toString();
  const r = await tiktokGet(`/open_api/v1.3/advertiser/info/?${qs}`, accessToken);
  if (r.code !== 0) {
    console.warn(`[warn] advertiser/info failed: ${r.message}. Defaulting to GMT+8.`);
    return {};
  }
  const map = {};
  for (const adv of r.data?.list || []) {
    map[String(adv.advertiser_id)] = parseOffsetHours(adv.timezone);
  }
  return map;
}

const DIMENSIONS = ['ad_id', 'stat_time_day'];
const METRICS = [
  'spend', 'cpm', 'ctr', 'cpc', 'impressions', 'clicks',
  'conversions', 'cost_per_conversion', 'real_time_roas',
  'app_install', 'cost_per_install', 'reach_cpm',
  'gross_impressions',          // 广告曝光事件总数
  'engaged_view',               // 活跃度
  'cost_per_engaged_view',      // 活跃度平均成本
  'engaged_view_rate',          // 广告曝光事件率
  'cost_per_gross_impressions', // 广告曝光事件平均成本 — verify
  'total_engaged_view_value',   // 广告曝光总价值
  'avg_engaged_view_value',     // 广告曝光事件平均价值
];

async function fetchTodayReport(advertiserId, date, accessToken) {
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
      multi_adv_report_in_utc_time: false,
    }).toString();
    const r = await tiktokGet(`/open_api/v1.3/report/integrated/get/?${qs}`, accessToken);
    if (r.code !== 0) throw new Error(`report adv=${advertiserId}: code=${r.code} ${r.message}`);
    all.push(...(r.data?.list || []));
    if (!r.data?.page_info?.has_more) break;
    page++;
  }
  return all;
}

// ─── Row mapping ──────────────────────────────────────────────────────────────

function num(v)  { const n = parseFloat(v); return isNaN(n) ? null : n; }
function str(v)  { return (v == null || v === '-') ? '' : String(v); }
function pct(v)  { const n = parseFloat(v); return isNaN(n) ? '' : (n * 100).toFixed(2) + '%'; }
function div(a, b) {
  const na = parseFloat(a), nb = parseFloat(b);
  return (!isNaN(na) && !isNaN(nb) && nb !== 0) ? parseFloat((na / nb).toFixed(4)) : null;
}

function mapRecord(row, advertiserName, tz, updateTime) {
  const d = row.dimensions || {};
  const m = row.metrics    || {};
  const gi = m.gross_impressions;
  const ev = m.engaged_view;
  return {
    '系列名称':               str(d.campaign_name),              //  1
    '按天':                   str(d.stat_time_day),              //  2
    '更新时间':               updateTime,                        //  3 Beijing time
    '消耗':                   num(m.spend),                      //  4
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
    '时区':                   tz,                               // 33
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

async function clearTable(token) {
  let deleted = 0;
  while (true) {
    const r = await feishuReq('GET',
      `/open-apis/bitable/v1/apps/${BITABLE_APP}/tables/${TABLE_ID}/records?page_size=500`, token);
    if (r.code !== 0) throw new Error(`list records: ${JSON.stringify(r)}`);
    const ids = (r.data?.items || []).map(x => x.record_id);
    if (!ids.length) break;
    const dr = await feishuReq('DELETE',
      `/open-apis/bitable/v1/apps/${BITABLE_APP}/tables/${TABLE_ID}/records/batch_delete`,
      token, { records: ids });
    if (dr.code !== 0) throw new Error(`batch_delete: ${JSON.stringify(dr)}`);
    deleted += ids.length;
    process.stdout.write(`\r  cleared ${deleted}...`);
  }
  if (deleted > 0) process.stdout.write('\n');
  return deleted;
}

async function batchCreate(token, records) {
  const BATCH = 500;
  let written = 0;
  for (let i = 0; i < records.length; i += BATCH) {
    const chunk = records.slice(i, i + BATCH);
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
  const updateTime = nowBeijing();
  console.log(`[realtime] ${updateTime} (Beijing)`);

  console.log('Getting Feishu token...');
  const feishuToken = await getFeishuToken();

  console.log(`Fetching advertisers from BC ${bcId}...`);
  const advertisers = await getAdvertisers(bcId, accessToken);
  console.log(`  ${advertisers.length} advertisers`);
  const tzMap = await getAdvertiserTimezones(advertisers, accessToken);

  // Fetch today's data for all accounts
  const allRecords = [];
  for (const adv of advertisers) {
    const offsetHours = tzMap[adv.id] ?? 8;
    const tz   = tzLabel(offsetHours);
    const date = process.env.TARGET_DATE || todayInOffset(offsetHours);
    process.stdout.write(`  [${adv.name}] ${tz} ${date} — `);
    const rows = await fetchTodayReport(adv.id, date, accessToken);
    process.stdout.write(`${rows.length} rows\n`);
    allRecords.push(...rows.map(row => mapRecord(row, adv.name, tz, updateTime)));
  }

  // Clear then write
  console.log('Clearing old data...');
  const cleared = await clearTable(feishuToken);
  console.log(`  cleared ${cleared} records`);

  if (!allRecords.length) { console.log('No data to write.'); return; }

  console.log(`Writing ${allRecords.length} records...`);
  await batchCreate(feishuToken, allRecords);
  console.log('Done.');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
