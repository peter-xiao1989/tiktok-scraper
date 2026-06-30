/**
 * TikTok Developer Portal product data → Feishu Spreadsheet (TT产品数据原表)
 *
 * Required env vars:
 *   TIKTOK_EMAIL / TIKTOK_PASSWORD  (or cached auth-state.json)
 * Optional:
 *   TARGET_DATE   YYYY-MM-DD override (default: yesterday)
 *   DAYS          number of days back to fetch (default: 1)
 *   START_DATE / END_DATE  explicit range
 *   FEISHU_APP_ID / FEISHU_APP_SECRET
 */

const https = require('https');
const { ensureLoggedIn, getCookieHeader } = require('./auth');
const { scrapeAll } = require('./scraper');
const { loadGames } = require('./games-loader');
const { ensureReportFormulas } = require('./build-report');
const { ensureDailySummary, ensureProjectSummary, ensureAdProductSummary, ensureAdMaterialSummary, ensureAdBidSummary } = require('./build-summaries');

const SPREADSHEET_TOKEN = 'J8mswO2vziyIAAkdt4rcVeaDnog';
const PRODUCT_SHEET_ID  = 'c50205';
const FEISHU_APP_ID     = process.env.FEISHU_APP_ID     || 'cli_aa898a664d395cc2';
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || (() => { throw new Error('FEISHU_APP_SECRET env is required'); })();

// 41-col header (A–AO) of TT产品数据原表
const PRODUCT_HEADERS = [
  '序号', '项目组', '游戏名称', '统计周期', '新增用户', '活跃用户', '重复用户', '有效用户',
  '总用户数', '总启动次数', '人均进入次数', '每位用户平均时长(分)', '次均游戏时长(分)',
  '平均启动速度(秒)', '平均首次启动速度(秒)', '启动成功率', '授权成功率', '次留', '7日留存',
  '14日留存', '30日留存', '广告请求量', '广告曝光量', '广告点击量', '广告点击率', 'eCPM',
  '人均广告展示次数', '广告总收入', '推荐页_广告支出', '推荐页_已激活用户', '推荐页_付费流量收入',
  '推荐页_首日激活用户', '推荐页_首日ARPU', '推荐页_首日eCPM', '推荐页_首日LTV', '推荐页_首日ROI',
  '推荐页_用户激活成本', '推荐页_首日付费收入', '推荐页_历史激活用户', '推荐页_历史eCPM', '推荐页_历史付费收入',
];

// ─── Date helpers ─────────────────────────────────────────────────────────────

function yesterdayISO() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function dateRange(start, end) {
  const dates = [];
  const cur = new Date(start);
  const last = new Date(end);
  while (cur <= last) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

function toISO(v) {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  const n = parseFloat(v);
  if (!isNaN(n) && n > 40000) {
    return new Date(Math.round((n - 25569) * 86400000)).toISOString().slice(0, 10);
  }
  return String(v).slice(0, 10);
}

// ─── KQL 分析台 D1 直推(抓完即写,独立于飞书;飞书配额死也照样进 D1) ──────────────
const _pn = v => { if (v == null || v === '') return 0; const n = parseFloat(String(v).replace(/[,%]/g, '')); return isNaN(n) ? 0 : n; };
const _pp = v => _pn(v) / 100;   // 百分比文本 → 小数
function _serial(d) { const m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(d)); return m ? Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000) + 25569 : 0; }
function mapToD1(row, date) {
  return {
    stat_date: date, stat_serial: _serial(date),
    group_name: row.项目组 || '', game: row.游戏名称 || '',
    new_users: _pn(row.新增用户), active_users: _pn(row.活跃用户),
    ad_revenue: _pn(row.广告总收入), ad_impressions: _pn(row.广告曝光量),
    ret_d1: _pp(row.次留), ret_d7: _pp(row.七日留存), ret_d14: _pp(row.十四日留存), ret_d30: _pp(row.三十日留存),
    ecpm: _pn(row.eCPM), portal_json: JSON.stringify(row),
  };
}
async function postProductsD1(d1Rows) {
  const url = (process.env.ANALYTICS_URL || '').replace(/\/$/, ''), tok = process.env.EXPORT_TOKEN;
  if (!url || !tok || !d1Rows.length) return;
  const https = require('https');
  for (let i = 0; i < d1Rows.length; i += 40) {
    const body = JSON.stringify({ rows: d1Rows.slice(i, i + 40) });
    await new Promise((res, rej) => {
      const u = new URL(url + '/api/ingest/products?token=' + encodeURIComponent(tok));
      const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, rs => { let c = ''; rs.on('data', d => c += d); rs.on('end', () => { try { JSON.parse(c).ok ? res() : rej(new Error(c.slice(0, 150))); } catch { rej(new Error(c.slice(0, 150))); } }); });
      req.on('error', rej); req.write(body); req.end();
    });
  }
  console.log(`✅ POST ${d1Rows.length} 行 → KQL 分析台 D1`);
}

// ─── Row mapping ──────────────────────────────────────────────────────────────

// Returns array matching columns A-AO of sheet c50205 (43 cols)
function recordToRow(row, seq) {
  return [
    seq,                      // A 序号
    row.项目组 || '',          // B 项目组
    row.游戏名称 || '',        // C 游戏名称
    row.统计周期 || '',        // D 统计周期
    row.新增用户 ?? '',        // E
    row.活跃用户 ?? '',        // F
    row.重复用户 ?? '',        // G
    row.有效用户 ?? '',        // H
    row.总用户数 ?? '',        // I
    row.总启动次数 ?? '',      // J
    row.人均进入次数 ?? '',    // K
    row['每位用户平均时长_分'] ?? '', // L
    row['次均游戏时长_分'] ?? '',     // M
    row['平均启动速度_秒'] ?? '',     // N
    row['平均首次启动速度_秒'] ?? '', // O
    row.启动成功率 ?? '',      // P
    row.授权成功率 ?? '',      // Q
    row.次留 ?? '',            // R
    row.七日留存 ?? '',        // S
    row.十四日留存 ?? '',      // T
    row.三十日留存 ?? '',      // U
    row.广告请求量 ?? '',      // V
    row.广告曝光量 ?? '',      // W
    row.广告点击量 ?? '',      // X
    row.广告点击率 ?? '',      // Y
    row.eCPM ?? '',            // Z
    row.人均广告展示次数 ?? '', // AA
    row.广告总收入 ?? '',      // AB
    row['推荐页_广告支出'] ?? '',      // AC
    row['推荐页_已激活用户'] ?? '',    // AD
    row['推荐页_付费流量收入'] ?? '',  // AE
    row['推荐页_首日激活用户'] ?? '',  // AF
    row['推荐页_首日ARPU'] ?? '',      // AG
    row['推荐页_首日eCPM'] ?? '',      // AH
    row['推荐页_首日LTV'] ?? '',       // AI
    row['推荐页_首日ROI'] ?? '',       // AJ
    row['推荐页_用户激活成本'] ?? '',  // AK
    row['推荐页_首日付费收入'] ?? '',  // AL
    row['推荐页_历史激活用户'] ?? '',  // AM
    row['推荐页_历史eCPM'] ?? '',      // AN
    row['推荐页_历史付费收入'] ?? '',  // AO
  ];
}

// ─── Feishu Spreadsheet API ───────────────────────────────────────────────────

function feishuReqOnce(method, path, token, body) {
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

async function feishuReq(method, path, token, body) {
  // Retry on rate-limit (90217 too many request / 90235 data not ready) + transient
  // network errors. Exponential backoff + jitter, cap ~15s, up to 10 tries (~1min
  // total) so a longer rate-limit window doesn't drop a write.
  const wait = a => new Promise(s => setTimeout(s, Math.min(15000, 500 * 2 ** a) + Math.random() * 500));
  for (let attempt = 0; ; attempt++) {
    let r;
    try { r = await feishuReqOnce(method, path, token, body); }
    catch (e) { if (attempt >= 9) throw e; await wait(attempt); continue; }
    if (r && (r.code === 90217 || r.code === 90235) && attempt < 9) { await wait(attempt); continue; }
    return r;
  }
}

async function getFeishuToken() {
  const r = await feishuReq('POST', '/open-apis/auth/v3/tenant_access_token/internal', '',
    { app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET });
  if (!r.tenant_access_token) throw new Error('Feishu auth failed: ' + JSON.stringify(r));
  return r.tenant_access_token;
}

async function readSheetRange(sheetId, range, token) {
  const r = await feishuReq('GET',
    `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values/${sheetId}!${range}`, token);
  return r.data?.valueRange?.values || [];
}

// Build dedup set from existing sheet: key = "gameName|YYYY-MM-DD"
// Reads C (index 2) = 游戏名称, D (index 3) = 统计周期
async function getExistingKeys(token) {
  const keys = new Set();
  let startRow = 2;
  while (true) {
    const endRow = startRow + 499;
    const rows = await readSheetRange(PRODUCT_SHEET_ID, `A${startRow}:D${endRow}`, token);
    if (!rows.length) break;
    let hasData = false;
    for (const row of rows) {
      const name = row[2]; // C 游戏名称
      const date = row[3]; // D 统计周期
      if (name && date != null && date !== '') {
        keys.add(`${name}|${toISO(date)}`);
        hasData = true;
      }
    }
    if (!hasData) break;
    process.stdout.write(`\r  read ${startRow + rows.length - 2} rows...`);
    if (rows.length < 500) break;
    startRow += 500;
  }
  process.stdout.write('\n');
  return keys;
}

async function getLastSeq(token) {
  const r = await feishuReq('GET',
    `/open-apis/sheets/v3/spreadsheets/${SPREADSHEET_TOKEN}/sheets/query`, token);
  const sheet = (r.data?.sheets || []).find(s => s.sheet_id === PRODUCT_SHEET_ID);
  const rowCount = sheet?.grid_properties?.row_count || 1;
  if (rowCount <= 1) return 0;
  const vals = await readSheetRange(PRODUCT_SHEET_ID, `A${rowCount}:A${rowCount}`, token);
  return parseInt(vals?.[0]?.[0] || '0', 10) || (rowCount - 1);
}

async function appendRows(rows, token) {
  const BATCH = 100;
  let written = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const r = await feishuReq('POST',
      `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values_append`,
      token, {
        valueRange: { range: `${PRODUCT_SHEET_ID}!A1:AO${chunk.length}`, values: chunk },
        insertDataOption: 'INSERT_ROWS',
      });
    if (r.code !== 0) throw new Error(`values_append: ${JSON.stringify(r)}`);
    written += chunk.length;
    process.stdout.write(`\r  written ${written}/${rows.length}...`);
  }
  process.stdout.write('\n');
}

// Delete all data rows (2+), keeping the header row.
async function clearSheetData(token) {
  const r = await feishuReq('GET',
    `/open-apis/sheets/v3/spreadsheets/${SPREADSHEET_TOKEN}/sheets/query`, token);
  const sheet = (r.data?.sheets || []).find(s => s.sheet_id === PRODUCT_SHEET_ID);
  const rowCount = sheet?.grid_properties?.row_count || 1;
  if (rowCount <= 1) { console.log('  Sheet already empty.'); return; }
  let remaining = rowCount - 1;
  let deleted = 0;
  while (remaining > 0) {
    const chunk = Math.min(remaining, 5000);
    const cr = await feishuReq('DELETE',
      `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/dimension_range`, token,
      { dimension: { sheetId: PRODUCT_SHEET_ID, majorDimension: 'ROWS', startIndex: 1, endIndex: chunk } });
    if (cr.code !== 0) throw new Error('dimension_range delete failed: ' + JSON.stringify(cr));
    deleted += cr.data?.delCount || chunk;
    remaining -= chunk;
    process.stdout.write(`\r  Deleted ${deleted} data rows...`);
  }
  process.stdout.write('\n');
  // Rewrite header to row 1 (delete can leave row 1 holding a stray data row)
  const hw = await feishuReq('PUT',
    `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values`, token,
    { valueRange: { range: `${PRODUCT_SHEET_ID}!A1:AO1`, values: [PRODUCT_HEADERS] } });
  if (hw.code !== 0) throw new Error('write headers failed: ' + JSON.stringify(hw));
  console.log('  Headers written to row 1.');
}

// Delete existing rows whose 统计周期 (D) falls in dateSet, so the day can be
// re-fetched and overwritten. Product data only settles at 16:00, so an early
// scrape may be empty/partial — the scheduled run must replace it, not skip it.
async function deleteRowsByDates(token, dateSet) {
  const targetRows = [];
  let startRow = 2;
  while (true) {
    const rows = await readSheetRange(PRODUCT_SHEET_ID, `D${startRow}:D${startRow + 499}`, token);
    if (!rows.length) break;
    let hasData = false;
    rows.forEach((row, i) => {
      const date = row[0];
      if (date != null && date !== '') {
        hasData = true;
        if (dateSet.has(toISO(date))) targetRows.push(startRow + i);
      }
    });
    if (!hasData || rows.length < 500) break;
    startRow += 500;
  }
  if (!targetRows.length) { console.log('  No existing rows for target dates — nothing to overwrite.'); return; }
  // merge consecutive row numbers into runs, delete bottom-up (so indices don't shift)
  targetRows.sort((a, b) => a - b);
  const runs = [];
  let lo = targetRows[0], hi = targetRows[0];
  for (let i = 1; i < targetRows.length; i++) {
    if (targetRows[i] === hi + 1) hi = targetRows[i];
    else { runs.push([lo, hi]); lo = hi = targetRows[i]; }
  }
  runs.push([lo, hi]);
  runs.sort((a, b) => b[0] - a[0]);
  let deleted = 0;
  for (const [a, b] of runs) {
    const cr = await feishuReq('DELETE',
      `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/dimension_range`, token,
      { dimension: { sheetId: PRODUCT_SHEET_ID, majorDimension: 'ROWS', startIndex: a - 1, endIndex: b } });
    if (cr.code !== 0) throw new Error('delete rows failed: ' + JSON.stringify(cr));
    deleted += (b - a + 1);
  }
  console.log(`  Overwrite: deleted ${deleted} existing rows for ${[...dateSet].join(',')}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { start, end } = (process.env.START_DATE && process.env.END_DATE)
    ? { start: process.env.START_DATE, end: process.env.END_DATE }
    : process.env.TARGET_DATE
      ? { start: process.env.TARGET_DATE, end: process.env.TARGET_DATE }
      : (() => {
          const days = parseInt(process.env.DAYS || '1', 10);
          const e = yesterdayISO();
          const s = new Date(e);
          s.setDate(s.getDate() - (days - 1));
          return { start: s.toISOString().slice(0, 10), end: e };
        })();

  const dates = dateRange(start, end);
  console.log(`Date range: ${start} → ${end} (${dates.length} days)`);

  const feishuToken = await getFeishuToken();

  const isClear = process.env.CLEAR_BEFORE === 'true';
  if (isClear) {
    console.log('Clearing product sheet data...');
    await clearSheetData(feishuToken);
  }

  let lastSeq = await getLastSeq(feishuToken);
  console.log(`  Last seq: ${lastSeq}`);

  console.log('Loading games...');
  const games = await loadGames(FEISHU_APP_ID, FEISHU_APP_SECRET);
  console.log(`  ${games.length} games`);

  const authState = await ensureLoggedIn();
  const portalCookies = getCookieHeader(authState, 'developers.tiktok.com');
  const dataCookies   = getCookieHeader(authState, 'developers.us.tiktok.com');

  // Scrape everything first; we only touch the sheet AFTER a successful scrape,
  // so a failed login can never delete a day's rows without re-writing them.
  const allRows = [], d1Rows = [];
  for (const date of dates) {
    process.stdout.write(`\n[${date}] scraping ${games.length} games...\n`);
    const results = await scrapeAll(games, date, portalCookies, dataCookies);
    for (const result of results) {
      if (!result.ok) continue;
      allRows.push(recordToRow(result.row, ++lastSeq));
      d1Rows.push(mapToD1(result.row, date));
    }
  }

  // 优先直推 KQL 分析台 D1(抓完即写,与飞书完全解耦——飞书配额死也不影响 D1)
  if (d1Rows.length) { try { await postProductsD1(d1Rows); } catch (e) { console.error('D1 直推失败:', e.message); } }

  if (allRows.length) {
    // 飞书写入:配额满/失败仅告警,不让整步失败(避免拖累 D1 自动化)
    try {
      if (!isClear) {
        console.log('\nReplacing target-date rows (delete old, then append fresh)...');
        await deleteRowsByDates(feishuToken, new Set(dates));
      }
      console.log(`Writing ${allRows.length} rows...`);
      await appendRows(allRows, feishuToken);
    } catch (e) { console.error('⚠️ 飞书写入失败(不影响 D1,已入库):', e.message); }
  } else {
    console.log('\nNo product rows scraped — keeping existing data (no delete).');
  }

  // Rewrite derived tables so Feishu recalcs them against the new 产品 data
  // (Feishu doesn't auto-recalc formulas when source data is written via API).
  const { maintainAllDerived } = require('./maintain-derived');
  await maintainAllDerived(feishuToken, '产品数据');
  console.log('Done.');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
