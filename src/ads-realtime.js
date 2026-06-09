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
  'conversion', 'cost_per_conversion',
  'app_install', 'cost_per_app_install', 'cost_per_1000_reached',
  'gross_impressions', 'engaged_view',
  'onsite_ad_impression_ad_revenue_roas',
  'onsite_unique_first_launch', 'onsite_cost_per_unique_first_launch',
  'onsite_unique_non_first_launch', 'onsite_cost_per_unique_non_first_launch',
  'onsite_launch_app_per_click', 'onsite_total_non_first_launch', 'onsite_cost_per_non_first_launch',
  'onsite_ad_impression_ad_revenue_calendar_day0',
  'onsite_ad_impression_ad_revenue_calendar_day6',
  'onsite_ad_impression_ad_revenue_calendar_day13',
  'onsite_ad_impression_ad_revenue_roas_calendar_day0',
  'onsite_ad_impression_ad_revenue_roas_calendar_day6',
  'onsite_ad_impression_ad_revenue_roas_calendar_day13',
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

// ─── Name enrichment ─────────────────────────────────────────────────────────

async function enrichNames(advertiserId, adIds, accessToken) {
  if (adIds.length === 0) return { adMap: {}, campMap: {}, agMap: {} };

  const adMap = {};
  for (let i = 0; i < adIds.length; i += 100) {
    const qs = new URLSearchParams({
      advertiser_id: advertiserId,
      filtering: JSON.stringify({ ad_ids: adIds.slice(i, i + 100) }),
      fields: JSON.stringify(['ad_id','ad_name','ad_text','adgroup_id','adgroup_name','campaign_id','campaign_name']),
      page_size: 100,
    }).toString();
    const r = await tiktokGet(`/open_api/v1.3/ad/get/?${qs}`, accessToken);
    if (r.code !== 0) { console.warn(`  [warn] ad/get: ${r.message}`); continue; }
    for (const ad of r.data?.list || []) adMap[ad.ad_id] = ad;
  }

  const campIds = [...new Set(Object.values(adMap).map(a => a.campaign_id).filter(Boolean))];
  const agIds   = [...new Set(Object.values(adMap).map(a => a.adgroup_id).filter(Boolean))];

  const campMap = {};
  for (let i = 0; i < campIds.length; i += 100) {
    const qs = new URLSearchParams({
      advertiser_id: advertiserId,
      filtering: JSON.stringify({ campaign_ids: campIds.slice(i, i + 100) }),
      fields: JSON.stringify(['campaign_id','objective_type','budget_mode','budget']),
      page_size: 100,
    }).toString();
    const r = await tiktokGet(`/open_api/v1.3/campaign/get/?${qs}`, accessToken);
    if (r.code === 0) for (const c of r.data?.list || []) campMap[c.campaign_id] = c;
  }

  const agMap = {};
  for (let i = 0; i < agIds.length; i += 100) {
    const qs = new URLSearchParams({
      advertiser_id: advertiserId,
      filtering: JSON.stringify({ adgroup_ids: agIds.slice(i, i + 100) }),
      fields: JSON.stringify(['adgroup_id','placement_type']),
      page_size: 100,
    }).toString();
    const r = await tiktokGet(`/open_api/v1.3/adgroup/get/?${qs}`, accessToken);
    if (r.code === 0) for (const ag of r.data?.list || []) agMap[ag.adgroup_id] = ag;
  }

  return { adMap, campMap, agMap };
}

// ─── Row mapping ──────────────────────────────────────────────────────────────

function num(v)  { const n = parseFloat(v); return isNaN(n) ? null : n; }
function str(v)  { return (v == null || v === '-') ? '' : String(v); }
function pct(v)  { const n = parseFloat(v); return isNaN(n) ? '' : n.toFixed(2) + '%'; }
function div(a, b) {
  const na = parseFloat(a), nb = parseFloat(b);
  return (!isNaN(na) && !isNaN(nb) && nb !== 0) ? parseFloat((na / nb).toFixed(4)) : null;
}

function mapRecord(row, adInfo, campInfo, agInfo, advertiserName, tz, updateTime) {
  const d = row.dimensions || {};
  const m = row.metrics    || {};
  const gi  = parseFloat(m.gross_impressions);
  const ev  = parseFloat(m.engaged_view);
  const imp = parseFloat(m.impressions);
  const date = str(d.stat_time_day).slice(0, 10);

  return {
    '系列名称':                 str(adInfo?.campaign_name),
    '按天':                     date,
    '更新时间':                 updateTime,
    '消耗':                     num(m.spend),
    '广告收入 ROAS (TikTok)':   num(m.onsite_ad_impression_ad_revenue_roas),
    '活跃度':                   num(m.onsite_unique_first_launch),
    '活跃度平均成本':            num(m.onsite_cost_per_unique_first_launch),
    '去重打开次数':              num(m.onsite_unique_non_first_launch),
    '去重打开平均成本':          num(m.onsite_cost_per_unique_non_first_launch),
    '打开率(%)':                pct(m.onsite_launch_app_per_click),
    '总打开次数':                num(m.onsite_total_non_first_launch),
    '打开平均成本':              num(m.onsite_cost_per_non_first_launch),
    '人均广告次数':              div(gi, ev),
    '点击率（目标页面）':        pct(m.ctr),
    '千次展示成本 (CPM)':       num(m.cpm),
    '平均点击成本（目标页面）':  num(m.cpc),
    '创意素材名称':              str(adInfo?.ad_name),
    '账户名称':                  advertiserName,
    '推广系列预算':              campInfo?.budget != null ? String(campInfo.budget) : '',
    '推广系列类型':              str(campInfo?.objective_type),
    '广告组名称':                str(adInfo?.adgroup_name),
    '广告位类型':                str(agInfo?.placement_type),
    '广告名称':                  str(adInfo?.ad_name),
    '广告文案':                  str(adInfo?.ad_text),
    '推广系列预算类型':          str(campInfo?.budget_mode),
    '应用安装数':                num(m.app_install),
    '应用安装平均成本':          num(m.cost_per_app_install),
    '点击量（目标页面）':        num(m.clicks),
    '展示量':                   num(m.impressions),
    '覆盖千人成本':              num(m.cost_per_1000_reached),
    '转化量':                   num(m.conversion),
    '平均转化成本':              num(m.cost_per_conversion),
    '广告曝光事件率':            !isNaN(ev) && !isNaN(imp) && imp > 0
                                   ? parseFloat((ev / imp * 100).toFixed(4)) + '%' : '',
    '广告曝光事件总数':          num(m.gross_impressions),
    '广告曝光事件平均成本':      div(m.spend, m.gross_impressions),
    '广告曝光总价值':            null,
    '广告曝光事件平均价值':      null,
    '第0日历日广告收入':         num(m.onsite_ad_impression_ad_revenue_calendar_day0),
    '第6日历日广告收入':         num(m.onsite_ad_impression_ad_revenue_calendar_day6),
    '第13日历日广告收入':        num(m.onsite_ad_impression_ad_revenue_calendar_day13),
    '第0日历日广告收入ROAS':     num(m.onsite_ad_impression_ad_revenue_roas_calendar_day0),
    '第6日历日广告收入ROAS':     num(m.onsite_ad_impression_ad_revenue_roas_calendar_day6),
    '第13日历日广告收入ROAS':    num(m.onsite_ad_impression_ad_revenue_roas_calendar_day13),
    '时区':                     tz,
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

const FIELD_DEFS = [
  { name: '系列名称',                 type: 1 },
  { name: '按天',                     type: 1 },
  { name: '更新时间',                 type: 1 },
  { name: '消耗',                     type: 2 },
  { name: '广告收入 ROAS (TikTok)',   type: 2 },
  { name: '活跃度',                   type: 2 },
  { name: '活跃度平均成本',           type: 2 },
  { name: '去重打开次数',             type: 2 },
  { name: '去重打开平均成本',         type: 2 },
  { name: '打开率(%)',               type: 1 },
  { name: '总打开次数',               type: 2 },
  { name: '打开平均成本',             type: 2 },
  { name: '人均广告次数',             type: 2 },
  { name: '点击率（目标页面）',       type: 1 },
  { name: '千次展示成本 (CPM)',       type: 2 },
  { name: '平均点击成本（目标页面）', type: 2 },
  { name: '创意素材名称',             type: 1 },
  { name: '账户名称',                 type: 1 },
  { name: '推广系列预算',             type: 1 },
  { name: '推广系列类型',             type: 1 },
  { name: '广告组名称',               type: 1 },
  { name: '广告位类型',               type: 1 },
  { name: '广告名称',                 type: 1 },
  { name: '广告文案',                 type: 1 },
  { name: '推广系列预算类型',         type: 1 },
  { name: '应用安装数',               type: 2 },
  { name: '应用安装平均成本',         type: 2 },
  { name: '点击量（目标页面）',       type: 2 },
  { name: '展示量',                   type: 2 },
  { name: '覆盖千人成本',             type: 2 },
  { name: '转化量',                   type: 2 },
  { name: '平均转化成本',             type: 2 },
  { name: '广告曝光事件率',           type: 1 },
  { name: '广告曝光事件总数',         type: 2 },
  { name: '广告曝光事件平均成本',     type: 2 },
  { name: '广告曝光总价值',           type: 2 },
  { name: '广告曝光事件平均价值',     type: 2 },
  { name: '第0日历日广告收入',        type: 2 },
  { name: '第6日历日广告收入',        type: 2 },
  { name: '第13日历日广告收入',       type: 2 },
  { name: '第0日历日广告收入ROAS',    type: 2 },
  { name: '第6日历日广告收入ROAS',    type: 2 },
  { name: '第13日历日广告收入ROAS',   type: 2 },
  { name: '时区',                     type: 1 },
];

async function setupFields(token) {
  const r = await feishuReq('GET',
    `/open-apis/bitable/v1/apps/${BITABLE_APP}/tables/${TABLE_ID}/fields?page_size=100`, token);
  const existing = r.data?.items || [];
  const existingNames = new Set(existing.map(f => f.field_name));
  for (const def of FIELD_DEFS) {
    if (!existingNames.has(def.name)) {
      await feishuReq('POST',
        `/open-apis/bitable/v1/apps/${BITABLE_APP}/tables/${TABLE_ID}/fields`,
        token, { field_name: def.name, type: def.type });
    }
  }
}

async function clearTable(token) {
  let deleted = 0;
  while (true) {
    const r = await feishuReq('GET',
      `/open-apis/bitable/v1/apps/${BITABLE_APP}/tables/${TABLE_ID}/records?page_size=500`, token);
    if (r.code !== 0) throw new Error(`list records: ${JSON.stringify(r)}`);
    const ids = (r.data?.items || []).map(x => x.record_id);
    if (!ids.length) break;
    const dr = await feishuReq('POST',
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

  await setupFields(feishuToken);

  console.log(`Fetching advertisers from BC ${bcId}...`);
  const advertisers = await getAdvertisers(bcId, accessToken);
  console.log(`  ${advertisers.length} advertisers`);
  const tzMap = await getAdvertiserTimezones(advertisers);

  // Fetch today's data for all accounts
  const allRecords = [];
  for (const adv of advertisers) {
    const offsetHours = tzMap[adv.id] ?? 8;
    const tz   = tzLabel(offsetHours);
    const date = process.env.TARGET_DATE || todayInOffset(offsetHours);
    process.stdout.write(`  [${adv.name}] ${tz} ${date} — `);
    const rows = await fetchTodayReport(adv.id, date, accessToken);
    process.stdout.write(`${rows.length} rows\n`);
    if (rows.length === 0) continue;

    const adIds = [...new Set(rows.map(r => r.dimensions.ad_id))];
    const { adMap, campMap, agMap } = await enrichNames(adv.id, adIds, accessToken);

    allRecords.push(...rows.map(row => {
      const adInfo   = adMap[row.dimensions.ad_id] || {};
      const campInfo = campMap[adInfo.campaign_id]  || {};
      const agInfo   = agMap[adInfo.adgroup_id]     || {};
      return mapRecord(row, adInfo, campInfo, agInfo, adv.name, tz, updateTime);
    }));
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
