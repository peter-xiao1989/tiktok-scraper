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
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || 'fOlixcmQNWlOBkrEAHagGdZUI5Fum3KX';

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

  if (process.env.CLEAR_BEFORE === 'true') {
    console.log('Clearing product sheet data...');
    await clearSheetData(feishuToken);
  }

  console.log('Loading existing keys for dedup...');
  const existingKeys = await getExistingKeys(feishuToken);
  console.log(`  ${existingKeys.size} existing game-date pairs`);

  let lastSeq = await getLastSeq(feishuToken);
  console.log(`  Last seq: ${lastSeq}`);

  console.log('Loading games...');
  const games = await loadGames(FEISHU_APP_ID, FEISHU_APP_SECRET);
  console.log(`  ${games.length} games`);

  const authState = await ensureLoggedIn();
  const portalCookies = getCookieHeader(authState, 'developers.tiktok.com');
  const dataCookies   = getCookieHeader(authState, 'developers.us.tiktok.com');

  const allRows = [];
  for (const date of dates) {
    process.stdout.write(`\n[${date}] scraping ${games.length} games...\n`);
    const results = await scrapeAll(games, date, portalCookies, dataCookies);

    for (const result of results) {
      if (!result.ok) continue;
      const row = result.row;
      const key = `${row.游戏名称}|${date}`;
      if (existingKeys.has(key)) {
        console.log(`  [${row.游戏名称}] already exists, skipped`);
        continue;
      }
      allRows.push(recordToRow(row, ++lastSeq));
      existingKeys.add(key);
    }
  }

  if (allRows.length) {
    console.log(`\nWriting ${allRows.length} rows...`);
    await appendRows(allRows, feishuToken);
  } else {
    console.log('\nNo new product rows.');
  }

  // Rewrite derived tables so Feishu recalcs them against the new 产品 data
  // (Feishu doesn't auto-recalc formulas when source data is written via API).
  const { maintainAllDerived } = require('./maintain-derived');
  await maintainAllDerived(feishuToken);
  console.log('Done.');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
