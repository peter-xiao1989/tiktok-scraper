/**
 * TikTok Marketing API v1.3 — realtime today's data → Feishu Spreadsheet (TT每日分时投放数据原表)
 *
 * Runs every 2 hours. Clears the sheet from row 2, then writes fresh today's data.
 *
 * Required env vars:
 *   TIKTOK_ACCESS_TOKEN
 * Optional:
 *   TARGET_DATE          YYYY-MM-DD override
 *   FEISHU_APP_ID / FEISHU_APP_SECRET
 *   TIKTOK_APP_ID / TIKTOK_APP_SECRET
 *   TIKTOK_BC_ID
 */

const https = require('https');

const SPREADSHEET_TOKEN  = 'J8mswO2vziyIAAkdt4rcVeaDnog';
const REALTIME_SHEET_ID  = 'jArZTX'; // TT每日分时投放数据原表
const FEISHU_APP_ID      = process.env.FEISHU_APP_ID     || 'cli_aa898a664d395cc2';
const FEISHU_APP_SECRET  = process.env.FEISHU_APP_SECRET || 'fOlixcmQNWlOBkrEAHagGdZUI5Fum3KX';
const TIKTOK_HOST        = 'business-api.tiktok.com';

// Column headers (row 1). Matches TT投放数据原表 A-AT + 更新时间 at end.
const HEADERS = [
  '序号','游戏名称','系列名称','更新时间','消耗','广告收入 ROAS (TikTok)','活跃度','活跃度平均成本',
  '人均广告次数','点击率（目标页面）','千次展示成本 (CPM)','平均点击成本（目标页面）',
  '创意素材名称','账户名称','推广系列预算','推广系列类型','广告组名称','广告位类型',
  '广告名称','广告文案','推广系列预算类型','应用安装数','应用安装平均成本',
  '点击量（目标页面）','展示量','覆盖千人成本','转化量','平均转化成本',
  '广告曝光事件率','广告曝光事件总数','广告曝光事件平均成本','广告曝光总价值','广告曝光事件平均价值',
  '时区','去重打开次数','去重打开平均成本','打开率(%)','总打开次数','打开平均成本',
  '第0日历日广告收入','第6日历日广告收入','第13日历日广告收入',
  '第0日历日广告收入ROAS','第6日历日广告收入ROAS','第13日历日广告收入ROAS',
  '出价方式',
];

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
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const d = Buffer.concat(chunks).toString('utf8');  // concat before decode (multibyte-safe)
          try { resolve(JSON.parse(d)); }
          catch (e) { reject(new Error(`TikTok non-JSON (HTTP ${res.statusCode}): ${d.slice(0, 200)}`)); }
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
      if (r.code !== 0) throw new Error(`${r.code} ${r.message}`);
      ids.push(...(r.data?.list || []).map(a => String(a.advertiser_id)));
      if (!r.data?.page_info?.has_more) break;
      page++;
    }
    if (ids.length > 0) return resolveAdvertiserInfo(ids, accessToken);
  } catch (e) {
    console.warn(`[warn] bc/advertiser/list: ${e.message}`);
  }
  const explicit = (process.env.TIKTOK_ADVERTISER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (explicit.length > 0) return resolveAdvertiserInfo(explicit, accessToken);
  throw new Error('Cannot get advertisers.');
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
      report_type: 'BASIC', data_level: 'AUCTION_AD',
      dimensions: JSON.stringify(DIMENSIONS),
      metrics: JSON.stringify(METRICS),
      start_date: date, end_date: date,
      page_size: 1000, page,
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

function num(v)  { const n = parseFloat(v); return isNaN(n) ? '' : n; }
function str(v)  { return (v == null || v === '-') ? '' : String(v); }
function pct(v)  { const n = parseFloat(v); return isNaN(n) ? '' : n.toFixed(2) + '%'; }
function div(a, b) {
  const na = parseFloat(a), nb = parseFloat(b);
  return (!isNaN(na) && !isNaN(nb) && nb !== 0) ? parseFloat((na / nb).toFixed(4)) : '';
}

function gameName(series) {
  if (!series) return '';
  return series.replace(/[^A-Za-z\s].*/s, '').trim();
}

function bidType(series) {
  return (series || '').includes('自动出价') ? '自动出价' : '手动出价';
}

// Returns array matching HEADERS order (A through AU)
function recordToRow(row, adInfo, campInfo, agInfo, advertiserName, tz, updateTime, seq) {
  const d = row.dimensions || {};
  const m = row.metrics    || {};
  const gi  = parseFloat(m.gross_impressions);
  const ev  = parseFloat(m.engaged_view);
  const imp = parseFloat(m.impressions);
  const series = str(adInfo?.campaign_name);
  const date   = str(d.stat_time_day).slice(0, 10);

  return [
    seq,                                              // A 序号
    gameName(series),                                 // B 游戏名称
    series,                                           // C 系列名称
    updateTime,                                       // D 更新时间
    num(m.spend),                                     // E 消耗
    num(m.onsite_ad_impression_ad_revenue_roas),       // F 广告收入 ROAS
    num(m.onsite_unique_first_launch),                 // G 活跃度
    num(m.onsite_cost_per_unique_first_launch),        // H 活跃度平均成本
    div(gi, ev),                                      // I 人均广告次数
    pct(m.ctr),                                       // J 点击率（目标页面）
    num(m.cpm),                                       // K 千次展示成本 (CPM)
    num(m.cpc),                                       // L 平均点击成本（目标页面）
    str(adInfo?.ad_name),                             // M 创意素材名称
    advertiserName,                                   // N 账户名称
    campInfo?.budget != null ? String(campInfo.budget) : '', // O 推广系列预算
    str(campInfo?.objective_type),                    // P 推广系列类型
    str(adInfo?.adgroup_name),                        // Q 广告组名称
    str(agInfo?.placement_type),                      // R 广告位类型
    str(adInfo?.ad_name),                             // S 广告名称
    str(adInfo?.ad_text),                             // T 广告文案
    str(campInfo?.budget_mode),                       // U 推广系列预算类型
    num(m.app_install),                               // V 应用安装数
    num(m.cost_per_app_install),                      // W 应用安装平均成本
    num(m.clicks),                                    // X 点击量（目标页面）
    num(m.impressions),                               // Y 展示量
    num(m.cost_per_1000_reached),                     // Z 覆盖千人成本
    num(m.conversion),                                // AA 转化量
    num(m.cost_per_conversion),                       // AB 平均转化成本
    (!isNaN(ev) && !isNaN(imp) && imp > 0            // AC 广告曝光事件率
      ? parseFloat((ev / imp * 100).toFixed(4)) + '%' : ''),
    num(m.gross_impressions),                         // AD 广告曝光事件总数
    div(m.spend, m.gross_impressions),                // AE 广告曝光事件平均成本
    '',                                               // AF 广告曝光总价值
    '',                                               // AG 广告曝光事件平均价值
    tz,                                               // AH 时区
    num(m.onsite_unique_non_first_launch),             // AI 去重打开次数
    num(m.onsite_cost_per_unique_non_first_launch),    // AJ 去重打开平均成本
    pct(m.onsite_launch_app_per_click),               // AK 打开率(%)
    num(m.onsite_total_non_first_launch),              // AL 总打开次数
    num(m.onsite_cost_per_non_first_launch),           // AM 打开平均成本
    num(m.onsite_ad_impression_ad_revenue_calendar_day0),   // AN 第0日历日广告收入
    num(m.onsite_ad_impression_ad_revenue_calendar_day6),   // AO 第6日历日广告收入
    num(m.onsite_ad_impression_ad_revenue_calendar_day13),  // AP 第13日历日广告收入
    num(m.onsite_ad_impression_ad_revenue_roas_calendar_day0),   // AQ 第0日历日广告收入ROAS
    num(m.onsite_ad_impression_ad_revenue_roas_calendar_day6),   // AR 第6日历日广告收入ROAS
    num(m.onsite_ad_impression_ad_revenue_roas_calendar_day13),  // AS 第13日历日广告收入ROAS
    bidType(series),                                  // AT 出价方式
  ];
}

// ─── Feishu Spreadsheet API ───────────────────────────────────────────────────

function feishuReq(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request({ hostname: 'open.feishu.cn', path, method, headers, timeout: 30000 },
      res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => {
        const d = Buffer.concat(chunks).toString('utf8');  // concat before decode (multibyte-safe)
        try { resolve(JSON.parse(d)); } catch(e) { reject(new Error(`non-JSON: ${d.slice(0,200)}`)); }
      }); });
    req.on('timeout', () => { req.destroy(); reject(new Error(`timeout: ${path}`)); });
    req.on('error', reject);
    if (data) req.write(data); req.end();
  });
}

async function getFeishuToken() {
  const r = await feishuReq('POST', '/open-apis/auth/v3/tenant_access_token/internal', '',
    { app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET });
  if (!r.tenant_access_token) throw new Error('Feishu auth failed: ' + JSON.stringify(r));
  return r.tenant_access_token;
}

// Get current data row count
async function getSheetRowCount(token) {
  const r = await feishuReq('GET',
    `/open-apis/sheets/v3/spreadsheets/${SPREADSHEET_TOKEN}/sheets/query`, token);
  const sheet = (r.data?.sheets || []).find(s => s.sheet_id === REALTIME_SHEET_ID);
  return sheet?.grid_properties?.row_count || 1;
}

// Write header row (always, to ensure correctness)
async function ensureHeaders(token) {
  const r = await feishuReq('PUT',
    `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values`, token, {
      valueRange: {
        range: `${REALTIME_SHEET_ID}!A1:AT1`,
        values: [HEADERS],
      },
    });
  if (r.code !== 0) throw new Error(`write headers: ${JSON.stringify(r)}`);
}

// Overwrite data area with new rows (row 2 onwards), clear any extra rows
async function writeDataRows(rows, currentRowCount, token) {
  const endRow = Math.max(currentRowCount, rows.length + 1);
  const lastCol = 'AT'; // 46 columns

  // Write data rows (row 2 to row rows.length+1)
  const BATCH = 100;
  let written = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const startRow = i + 2;
    const endDataRow = startRow + chunk.length - 1;
    const r = await feishuReq('PUT',
      `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values`, token, {
        valueRange: {
          range: `${REALTIME_SHEET_ID}!A${startRow}:${lastCol}${endDataRow}`,
          values: chunk,
        },
      });
    if (r.code !== 0) throw new Error(`values PUT: ${JSON.stringify(r)}`);
    written += chunk.length;
    process.stdout.write(`\r  written ${written}/${rows.length}...`);
  }
  process.stdout.write('\n');

  // Clear remaining rows from previous run (if any)
  const lastNewRow = rows.length + 1;
  if (currentRowCount > lastNewRow) {
    const clearCount = currentRowCount - lastNewRow;
    const emptyRows = Array.from({ length: clearCount }, () => Array(HEADERS.length).fill(''));
    for (let i = 0; i < emptyRows.length; i += BATCH) {
      const chunk = emptyRows.slice(i, i + BATCH);
      const startRow = lastNewRow + 1 + i;
      const endRow2  = startRow + chunk.length - 1;
      await feishuReq('PUT',
        `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values`, token, {
          valueRange: {
            range: `${REALTIME_SHEET_ID}!A${startRow}:${lastCol}${endRow2}`,
            values: chunk,
          },
        });
    }
    console.log(`  Cleared ${clearCount} extra rows.`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const accessToken = process.env.TIKTOK_ACCESS_TOKEN;
  if (!accessToken) { console.error('TIKTOK_ACCESS_TOKEN required'); process.exit(1); }
  const updateTime = nowBeijing();
  console.log(`[realtime] ${updateTime} (Beijing)`);

  const feishuToken = await getFeishuToken();

  await ensureHeaders(feishuToken);
  const currentRowCount = await getSheetRowCount(feishuToken);
  console.log(`  Current sheet rows: ${currentRowCount}`);

  console.log('Fetching advertisers...');
  const advertisers = await getAdvertisers(accessToken);
  console.log(`  ${advertisers.length} advertisers`);

  const allRows = [];
  let seq = 0;
  for (const adv of advertisers) {
    const tz   = tzLabel(adv.offsetHours);
    const date = process.env.TARGET_DATE || todayInOffset(adv.offsetHours);
    process.stdout.write(`  [${adv.name}] ${tz} ${date} — `);

    let rows;
    try {
      rows = await fetchTodayReport(adv.id, date, accessToken);
    } catch (e) {
      console.warn(`\n  [warn] ${e.message}`);
      continue;
    }
    process.stdout.write(`${rows.length} rows\n`);
    if (rows.length === 0) continue;

    const adIds = [...new Set(rows.map(r => r.dimensions.ad_id))];
    const { adMap, campMap, agMap } = await enrichNames(adv.id, adIds, accessToken);

    for (const row of rows) {
      const adInfo   = adMap[row.dimensions.ad_id] || {};
      const campInfo = campMap[adInfo.campaign_id]  || {};
      const agInfo   = agMap[adInfo.adgroup_id]     || {};
      allRows.push(recordToRow(row, adInfo, campInfo, agInfo, adv.name, tz, updateTime, ++seq));
    }
  }

  if (!allRows.length) { console.log('No data to write.'); return; }

  console.log(`Writing ${allRows.length} rows...`);
  await writeDataRows(allRows, currentRowCount, feishuToken);
  await setRoasFormat(feishuToken, allRows.length + 1);
  console.log('Done.');
}

// Set ROAS columns (F, AQ:AS) to percent format over the written data rows.
async function setRoasFormat(token, lastRow) {
  if (lastRow < 2) return;
  for (const range of [`${REALTIME_SHEET_ID}!F2:F${lastRow}`, `${REALTIME_SHEET_ID}!AQ2:AS${lastRow}`]) {
    const s = await feishuReq('PUT', `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/style`,
      token, { appendStyle: { range, style: { formatter: '0.00%' } } });
    if (s.code !== 0) console.warn(`  [warn] ROAS fmt ${range}: ${s.msg}`);
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
