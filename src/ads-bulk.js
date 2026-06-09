/**
 * TikTok Marketing API — bulk historical import → Feishu Bitable (TT投放数据原表)
 *
 * Required env:
 *   TIKTOK_ACCESS_TOKEN
 * Optional:
 *   START_DATE   YYYY-MM-DD (default: 2026-05-15)
 *   END_DATE     YYYY-MM-DD (default: yesterday in BJT)
 *   FEISHU_APP_ID / FEISHU_APP_SECRET
 */

const https = require('https');

const BITABLE_APP       = 'HCXKb9qoDaiEmqsl4cocOnNPnpb';
const TABLE_NAME        = 'TT投放数据原表';
const FEISHU_APP_ID     = process.env.FEISHU_APP_ID     || 'cli_aa898a664d395cc2';
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || 'fOlixcmQNWlOBkrEAHagGdZUI5Fum3KX';
const TIKTOK_HOST       = 'business-api.tiktok.com';

// ─── Field definitions ────────────────────────────────────────────────────────

const FIELD_DEFS = [
  { name: '系列名称',                 type: 1 },
  { name: '按天',                     type: 1 },
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

// ─── Date helpers ─────────────────────────────────────────────────────────────

function dateRange(start, end) {
  const dates = [];
  const cur = new Date(start + 'T00:00:00Z');
  const endD = new Date(end + 'T00:00:00Z');
  while (cur <= endD) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

function yesterdayBJT() {
  return new Date(Date.now() + 8 * 3600000 - 86400000).toISOString().slice(0, 10);
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

// ─── TikTok API ───────────────────────────────────────────────────────────────

function tiktokGet(path, accessToken) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: TIKTOK_HOST, path, method: 'GET',
        headers: { 'Access-Token': accessToken, 'Content-Type': 'application/json' } },
      res => { let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(new Error(`non-JSON: ${d.slice(0,200)}`)); } }); }
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

async function getAdvertisers(accessToken) {
  const appId = process.env.TIKTOK_APP_ID;
  const appSecret = process.env.TIKTOK_APP_SECRET;

  if (appId && appSecret) {
    const qs = new URLSearchParams({ app_id: appId, secret: appSecret, access_token: accessToken }).toString();
    const r = await tiktokGet(`/open_api/v1.3/oauth2/advertiser/get/?${qs}`, accessToken);
    if (r.code === 0) {
      const ids = (r.data?.list || []).map(a => String(a.advertiser_id));
      console.log(`  oauth2/advertiser/get → ${ids.length} advertisers`);
      return resolveAdvertiserInfo(ids, accessToken);
    }
    console.warn(`[warn] oauth2/advertiser/get: ${r.message}`);
  }

  const bcId = process.env.TIKTOK_BC_ID || '7623379731659948049';
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
    if (ids.length > 0) {
      console.log(`  bc/advertiser/list → ${ids.length} advertisers`);
      return resolveAdvertiserInfo(ids, accessToken);
    }
  } catch (e) {
    console.warn(`[warn] bc/advertiser/list: ${e.message}`);
  }

  const explicitIds = (process.env.TIKTOK_ADVERTISER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (explicitIds.length > 0) return resolveAdvertiserInfo(explicitIds, accessToken);
  throw new Error('Cannot get advertisers. Set TIKTOK_APP_ID+TIKTOK_APP_SECRET, TIKTOK_BC_ID, or TIKTOK_ADVERTISER_IDS.');
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

async function fetchReport(advertiserId, date, accessToken) {
  const all = [];
  let page = 1;
  while (true) {
    const qs = new URLSearchParams({
      advertiser_id: advertiserId,
      report_type: 'BASIC', data_level: 'AUCTION_AD',
      dimensions: JSON.stringify(DIMENSIONS),
      metrics: JSON.stringify(METRICS),
      start_date: date, end_date: date,
      page_size: 1000, page,
      multi_adv_report_in_utc_time: false,
    }).toString();
    const r = await tiktokGet(`/open_api/v1.3/report/integrated/get/?${qs}`, accessToken);
    if (r.code !== 0) throw new Error(`report adv=${advertiserId} date=${date}: code=${r.code} ${r.message}`);
    all.push(...(r.data?.list || []));
    if (!r.data?.page_info?.has_more) break;
    page++;
  }
  return all;
}

// ─── Name enrichment ──────────────────────────────────────────────────────────

async function enrichNames(advertiserId, adIds, accessToken) {
  if (adIds.length === 0) return { adMap: {}, campMap: {}, agMap: {} };

  const adMap = {};
  // ad/get in batches of 100
  for (let i = 0; i < adIds.length; i += 100) {
    const batch = adIds.slice(i, i + 100);
    const qs = new URLSearchParams({
      advertiser_id: advertiserId,
      filtering: JSON.stringify({ ad_ids: batch }),
      fields: JSON.stringify(['ad_id','ad_name','ad_text','adgroup_id','adgroup_name','campaign_id','campaign_name']),
      page_size: 100,
    }).toString();
    const r = await tiktokGet(`/open_api/v1.3/ad/get/?${qs}`, accessToken);
    if (r.code !== 0) { console.warn(`  [warn] ad/get: ${r.message}`); continue; }
    for (const ad of r.data?.list || []) adMap[ad.ad_id] = ad;
  }

  // collect unique campaign_ids and adgroup_ids
  const campIds = [...new Set(Object.values(adMap).map(a => a.campaign_id).filter(Boolean))];
  const agIds   = [...new Set(Object.values(adMap).map(a => a.adgroup_id).filter(Boolean))];

  const campMap = {};
  for (let i = 0; i < campIds.length; i += 100) {
    const batch = campIds.slice(i, i + 100);
    const qs = new URLSearchParams({
      advertiser_id: advertiserId,
      filtering: JSON.stringify({ campaign_ids: batch }),
      fields: JSON.stringify(['campaign_id','objective_type','budget_mode','budget']),
      page_size: 100,
    }).toString();
    const r = await tiktokGet(`/open_api/v1.3/campaign/get/?${qs}`, accessToken);
    if (r.code === 0) for (const c of r.data?.list || []) campMap[c.campaign_id] = c;
  }

  const agMap = {};
  for (let i = 0; i < agIds.length; i += 100) {
    const batch = agIds.slice(i, i + 100);
    const qs = new URLSearchParams({
      advertiser_id: advertiserId,
      filtering: JSON.stringify({ adgroup_ids: batch }),
      fields: JSON.stringify(['adgroup_id','placement_type','budget_mode','budget']),
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
function pct(v)  { const n = parseFloat(v); return isNaN(n) ? '' : n.toFixed(2) + '%'; }  // API already returns % value
function div(a, b) {
  const na = parseFloat(a), nb = parseFloat(b);
  return (!isNaN(na) && !isNaN(nb) && nb !== 0) ? parseFloat((na / nb).toFixed(4)) : null;
}

function mapRecord(row, adInfo, campInfo, agInfo, advertiserName, tz) {
  const d = row.dimensions || {};
  const m = row.metrics    || {};
  const gi  = parseFloat(m.gross_impressions);
  const ev  = parseFloat(m.engaged_view);
  const imp = parseFloat(m.impressions);

  // date: API returns "2026-05-15 00:00:00", keep only YYYY-MM-DD
  const date = str(d.stat_time_day).slice(0, 10);
  const adId = str(d.ad_id);

  return {
    '记录标识':                 `${advertiserName}|${date}|${adId}`,
    '系列名称':                 str(adInfo?.campaign_name),
    '按天':                     date,
    '消耗':                     num(m.spend),
    '广告收入 ROAS (TikTok)':   num(m.onsite_ad_impression_ad_revenue_roas),
    '活跃度':                   num(m.onsite_unique_first_launch),
    '活跃度平均成本':           num(m.onsite_cost_per_unique_first_launch),
    '去重打开次数':             num(m.onsite_unique_non_first_launch),
    '去重打开平均成本':         num(m.onsite_cost_per_unique_non_first_launch),
    '打开率(%)':               pct(m.onsite_launch_app_per_click),
    '总打开次数':               num(m.onsite_total_non_first_launch),
    '打开平均成本':             num(m.onsite_cost_per_non_first_launch),
    '人均广告次数':             div(gi, ev),
    '点击率（目标页面）':       pct(m.ctr),
    '千次展示成本 (CPM)':       num(m.cpm),
    '平均点击成本（目标页面）': num(m.cpc),
    '创意素材名称':             str(adInfo?.ad_name),
    '账户名称':                 advertiserName,
    '推广系列预算':             campInfo?.budget != null ? String(campInfo.budget) : '',
    '推广系列类型':             str(campInfo?.objective_type),
    '广告组名称':               str(adInfo?.adgroup_name),
    '广告位类型':               str(agInfo?.placement_type),
    '广告名称':                 str(adInfo?.ad_name),
    '广告文案':                 str(adInfo?.ad_text),
    '推广系列预算类型':         str(campInfo?.budget_mode),
    '应用安装数':               num(m.app_install),
    '应用安装平均成本':         num(m.cost_per_app_install),
    '点击量（目标页面）':       num(m.clicks),
    '展示量':                   num(m.impressions),
    '覆盖千人成本':             num(m.cost_per_1000_reached),
    '转化量':                   num(m.conversion),
    '平均转化成本':             num(m.cost_per_conversion),
    '广告曝光事件率':           !isNaN(ev) && !isNaN(imp) && imp > 0
                                  ? parseFloat((ev / imp * 100).toFixed(4)) + '%' : '',
    '广告曝光事件总数':         num(m.gross_impressions),
    '广告曝光事件平均成本':     div(m.spend, m.gross_impressions),
    '广告曝光总价值':           null,
    '广告曝光事件平均价值':     null,
    '第0日历日广告收入':        num(m.onsite_ad_impression_ad_revenue_calendar_day0),
    '第6日历日广告收入':        num(m.onsite_ad_impression_ad_revenue_calendar_day6),
    '第13日历日广告收入':       num(m.onsite_ad_impression_ad_revenue_calendar_day13),
    '第0日历日广告收入ROAS':    num(m.onsite_ad_impression_ad_revenue_roas_calendar_day0),
    '第6日历日广告收入ROAS':    num(m.onsite_ad_impression_ad_revenue_roas_calendar_day6),
    '第13日历日广告收入ROAS':   num(m.onsite_ad_impression_ad_revenue_roas_calendar_day13),
    '时区':                     tz,
  };
}

// ─── Feishu helpers ───────────────────────────────────────────────────────────

function feishuReq(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request({ hostname: 'open.feishu.cn', path, method, headers },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d))); });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function getFeishuToken() {
  const r = await feishuReq('POST', '/open-apis/auth/v3/tenant_access_token/internal', '',
    { app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET });
  if (!r.tenant_access_token) throw new Error('Feishu auth failed: ' + JSON.stringify(r));
  return r.tenant_access_token;
}

async function findOrCreateTable(token) {
  const r = await feishuReq('GET',
    `/open-apis/bitable/v1/apps/${BITABLE_APP}/tables?page_size=50`, token);
  const existing = (r.data?.items || []).find(t => t.name === TABLE_NAME);
  if (existing) {
    console.log(`Table "${TABLE_NAME}" exists: ${existing.table_id}`);
    return existing.table_id;
  }
  console.log(`Creating table "${TABLE_NAME}"...`);
  const cr = await feishuReq('POST',
    `/open-apis/bitable/v1/apps/${BITABLE_APP}/tables`, token,
    { table: { name: TABLE_NAME } });
  if (cr.code !== 0) throw new Error('Create table failed: ' + JSON.stringify(cr));
  console.log(`  Created: ${cr.data.table_id}`);
  return cr.data.table_id;
}

async function setupFields(tableId, token) {
  const r = await feishuReq('GET',
    `/open-apis/bitable/v1/apps/${BITABLE_APP}/tables/${tableId}/fields?page_size=100`, token);
  const existing = r.data?.items || [];
  const existingNames = new Set(existing.map(f => f.field_name));

  // Rename the Feishu default primary field to '记录标识' for composite key
  const primaryField = existing.find(f => !FIELD_DEFS.some(d => d.name === f.field_name) && f.field_name !== '记录标识');
  if (primaryField) {
    await feishuReq('PUT',
      `/open-apis/bitable/v1/apps/${BITABLE_APP}/tables/${tableId}/fields/${primaryField.field_id}`,
      token, { field_name: '记录标识', type: 1 });
    existingNames.delete(primaryField.field_name);
    existingNames.add('记录标识');
  }

  for (const def of FIELD_DEFS) {
    if (!existingNames.has(def.name)) {
      const cr = await feishuReq('POST',
        `/open-apis/bitable/v1/apps/${BITABLE_APP}/tables/${tableId}/fields`,
        token, { field_name: def.name, type: def.type });
      if (cr.code !== 0) console.warn(`  Warning: field "${def.name}": ${cr.msg}`);
    }
  }
  console.log('  Fields ready.');
}

async function clearTable(tableId, token) {
  let deleted = 0;
  while (true) {
    const r = await feishuReq('GET',
      `/open-apis/bitable/v1/apps/${BITABLE_APP}/tables/${tableId}/records?page_size=500`, token);
    if (r.code !== 0) throw new Error('list records: ' + JSON.stringify(r));
    const ids = (r.data?.items || []).map(i => i.record_id);
    if (ids.length === 0) break;
    const dr = await feishuReq('POST',
      `/open-apis/bitable/v1/apps/${BITABLE_APP}/tables/${tableId}/records/batch_delete`,
      token, { records: ids });
    if (dr.code !== 0) throw new Error('batch_delete: ' + JSON.stringify(dr));
    deleted += ids.length;
    process.stdout.write(`\r  deleted ${deleted}...`);
    if (!r.data?.has_more) break;
  }
  if (deleted > 0) process.stdout.write('\n');
  console.log(`  Cleared ${deleted} records.`);
}

async function getExistingKeys(tableId, token) {
  const keys = new Set();
  let pageToken = '';
  do {
    const qs = `page_size=500${pageToken ? '&page_token=' + pageToken : ''}`;
    const r = await feishuReq('GET',
      `/open-apis/bitable/v1/apps/${BITABLE_APP}/tables/${tableId}/records?${qs}`, token);
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

async function batchCreate(tableId, token, records) {
  const BATCH = 500;
  let written = 0;
  for (let i = 0; i < records.length; i += BATCH) {
    const cleaned = records.slice(i, i + BATCH).map(fields => ({
      fields: Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== null && v !== ''))
    }));
    const r = await feishuReq('POST',
      `/open-apis/bitable/v1/apps/${BITABLE_APP}/tables/${tableId}/records/batch_create`,
      token, { records: cleaned });
    if (r.code !== 0) throw new Error(`batch_create: ${JSON.stringify(r)}`);
    written += cleaned.length;
    process.stdout.write(`\r  written ${written}/${records.length}...`);
  }
  process.stdout.write('\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const accessToken = process.env.TIKTOK_ACCESS_TOKEN;
  if (!accessToken) { console.error('TIKTOK_ACCESS_TOKEN required'); process.exit(1); }

  const startDate = process.env.START_DATE || '2026-05-15';
  const endDate   = process.env.END_DATE   || yesterdayBJT();
  const dates = dateRange(startDate, endDate);
  console.log(`Date range: ${startDate} → ${endDate} (${dates.length} days)`);

  const feishuToken = await getFeishuToken();
  const tableId = await findOrCreateTable(feishuToken);

  console.log('Setting up fields...');
  await setupFields(tableId, feishuToken);

  if (process.env.CLEAR_TABLE === '1') {
    console.log('Clearing existing records...');
    await clearTable(tableId, feishuToken);
  }

  console.log('Loading existing records for dedup...');
  const existingKeys = await getExistingKeys(tableId, feishuToken);
  console.log(`  ${existingKeys.size} existing records`);

  console.log('Fetching advertisers...');
  const advertisers = await getAdvertisers(accessToken);
  console.log(`  ${advertisers.length} advertisers`);

  let totalWritten = 0;
  for (const date of dates) {
    const allRecords = [];
    for (const adv of advertisers) {
      const tz = tzLabel(adv.offsetHours);
      const key = `${adv.name}|${date}`;
      if (existingKeys.has(key)) { continue; }

      let rows;
      try {
        rows = await fetchReport(adv.id, date, accessToken);
      } catch (e) {
        console.warn(`  [warn] ${date} ${adv.name}: ${e.message}`);
        continue;
      }
      if (rows.length === 0) continue;

      // Enrich with names from ad/get + campaign/get + adgroup/get
      const adIds = [...new Set(rows.map(r => r.dimensions.ad_id))];
      const { adMap, campMap, agMap } = await enrichNames(adv.id, adIds, accessToken);

      const mapped = rows.map(row => {
        const adInfo   = adMap[row.dimensions.ad_id]           || {};
        const campInfo = campMap[adInfo.campaign_id]           || {};
        const agInfo   = agMap[adInfo.adgroup_id]              || {};
        return mapRecord(row, adInfo, campInfo, agInfo, adv.name, tz);
      });

      process.stdout.write(`  [${date}][${adv.name}] ${rows.length} rows\n`);
      allRecords.push(...mapped);
      existingKeys.add(key);
    }

    if (allRecords.length > 0) {
      process.stdout.write(`  Writing ${allRecords.length} records for ${date}...`);
      await batchCreate(tableId, feishuToken, allRecords);
      totalWritten += allRecords.length;
    }
  }

  console.log(`\nDone. Total written: ${totalWritten} records.`);
  console.log(`TABLE_ID: ${tableId}`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
