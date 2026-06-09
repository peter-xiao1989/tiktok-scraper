/**
 * Build 产品经营日报表 (6B1PVx) — pure-formula, reverse-mirrors 产品数据原表.
 *
 * Each report row r references 产品数据原表 row (dataCount - r + 2) so the
 * newest imported day surfaces at the top. 消耗/ROAS/活跃度平均成本 aggregate
 * from 投放数据原表 via SUMIFS/SUMPRODUCT keyed on 游戏名称 + 日期.
 *
 * Rows filled = product data rows + ROW_BUFFER (keeps a buffer so newly
 * imported days/games appear automatically without editing formulas).
 *
 * Run standalone:  node src/build-report.js
 * Reused daily:    product-api.js calls ensureReportFormulas() after import.
 */

const https = require('https');

const SPREADSHEET_TOKEN = 'J8mswO2vziyIAAkdt4rcVeaDnog';
const REPORT_SHEET_ID   = '6B1PVx';
const PROD = "'TT产品数据原表'";
const ADS  = "'TT投放数据原表'";
const ROW_BUFFER = 200;
const FEISHU_APP_ID     = process.env.FEISHU_APP_ID     || 'cli_aa898a664d395cc2';
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || 'fOlixcmQNWlOBkrEAHagGdZUI5Fum3KX';

function feishuReq(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request({ hostname: 'open.feishu.cn', path, method, headers, timeout: 30000 },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(new Error(`non-JSON: ${d.slice(0, 200)}`)); }
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

// INDEX into 产品数据原表 column `col` at the reverse-mirrored source row $U{r}
function colLetter(n) { let c = ''; while (n > 0) { const r = (n - 1) % 26; c = String.fromCharCode(65 + r) + c; n = Math.floor((n - 1) / 26); } return c; }

// Report field -> data source. Formulas are placed by HEADER NAME (not by a
// fixed column position), so reordering report columns never misaligns values.
// kind 'prod' pulls 产品数据原表 column `col`; others compute from 投放数据原表.
const FIELD_SRC = {
  '序号': { kind: 'seq' },
  '统计周期': { kind: 'prod', col: 'D' },
  '项目组': { kind: 'prod', col: 'B' },
  '游戏名称': { kind: 'prod', col: 'C' },
  '消耗': { kind: 'spend' },
  '广告收入 ROAS (TikTok)': { kind: 'roas' },
  '活跃度平均成本': { kind: 'activecost' },
  '运营新增成本': { kind: 'opcost' },
  '新增用户': { kind: 'prod', col: 'E' },
  '活跃用户': { kind: 'prod', col: 'F' },
  '人均进入次数': { kind: 'prod', col: 'K' },
  '每位用户平均时长(分)': { kind: 'prod', col: 'L' },
  '平均启动速度(秒)': { kind: 'prod', col: 'N' },
  '平均首次启动速度(秒)': { kind: 'prod', col: 'O' },
  '启动成功率': { kind: 'prod', col: 'P' },
  'eCPM': { kind: 'prod', col: 'Z' },
  '广告点击率': { kind: 'prod', col: 'Y' },
  '人均广告展示次数': { kind: 'prod', col: 'AA' },
  '广告总收入': { kind: 'prod', col: 'AB' },
};

async function readHeader(token) {
  const r = await feishuReq('GET',
    `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values/${REPORT_SHEET_ID}!A1:AZ1`, token);
  return (r.data?.valueRange?.values?.[0] || []).map(v => (v == null ? '' : String(v).trim()));
}

// Build { columnLetter -> formulaGenerator(r) } from the live header row.
// SRCN(U) = source product row for this report row; KEY(W) = per-product-row
// sort key = date*1e7 + group-day-spend*1e3 + game-day-spend, so report rows
// order by date desc, then 项目组 by its day spend desc, then games within a
// group by spend. fullMap (game→group incl. extras) feeds the group-spend calc.
const SRCN = 'U', KEY = 'W';
function buildPlan(header, reportGroupGames) {
  const nameToLetter = {};
  header.forEach((name, j) => { if (name && !nameToLetter[name]) nameToLetter[name] = colLetter(j + 1); });
  const gCol = nameToLetter['游戏名称'], dCol = nameToLetter['统计周期'], eCol = nameToLetter['消耗'],
        nCol = nameToLetter['新增用户'], sCol = nameToLetter['广告总收入'];
  for (const [n, v] of [['游戏名称', gCol], ['统计周期', dCol], ['消耗', eCol], ['新增用户', nCol], ['广告总收入', sCol]]) {
    if (!v) throw new Error(`日报表缺少必需表头列: ${n}`);
  }
  // group-day spend for product row r: nested IF over each 项目组, summing 投放
  // 消耗 of that group's games (ISNUMBER(MATCH) array, no #N/A poisoning).
  const reportGroups = Object.keys(reportGroupGames);
  const groupSpend = r => reportGroups.reduceRight((acc, grp) => {
    const games = `{${reportGroupGames[grp].map(x => `"${x.replace(/"/g, '""')}"`).join(',')}}`;
    return `IF(${PROD}!$B${r}="${grp}",SUMPRODUCT(ISNUMBER(MATCH(${ADS}!$B$2:$B$5000,${games},0))*(${ADS}!$D$2:$D$5000=${PROD}!$D${r})*${ADS}!$E$2:$E$5000),${acc})`;
  }, '0');
  const prodIdxAt = col => r => `=IFERROR(IF($${SRCN}${r}<1,"",INDEX(${PROD}!$${col}$2:$${col}$5000,$${SRCN}${r})),"")`;
  const sumifs = (col, r) => `SUMIFS(${ADS}!$${col}$2:$${col}$5000,${ADS}!$B$2:$B$5000,$${gCol}${r},${ADS}!$D$2:$D$5000,TEXT($${dCol}${r},"yyyy-MM-dd"))`;
  const gen = {
    seq: r => `=IF($${gCol}${r}="","",ROW()-1)`,
    spend: r => `=IF($${gCol}${r}="","",${sumifs('E', r)})`,
    roas: r => `=IF($${gCol}${r}="","",IFERROR(SUMPRODUCT((${ADS}!$B$2:$B$5000=$${gCol}${r})*(${ADS}!$D$2:$D$5000=TEXT($${dCol}${r},"yyyy-MM-dd"))*${ADS}!$F$2:$F$5000*${ADS}!$E$2:$E$5000)/$${eCol}${r},""))`,
    activecost: r => `=IF($${gCol}${r}="","",IFERROR($${eCol}${r}/${sumifs('G', r)},""))`,
    opcost: r => `=IF($${gCol}${r}="","",IFERROR($${eCol}${r}/$${nCol}${r},""))`,
  };
  const plan = {};
  header.forEach((name, j) => {
    const spec = FIELD_SRC[name];
    if (!spec) return;
    plan[colLetter(j + 1)] = spec.kind === 'prod' ? prodIdxAt(spec.col) : gen[spec.kind];
  });
  // KEY(W): integer sort key = date*1e8 + group-day-spend*1e4 + (5000-row)
  // tiebreak. Orders by date desc, then 项目组 by day spend desc, then product
  // import order within a group. Integer (no decimals) → no precision collisions.
  plan[KEY] = r => `=IF(${PROD}!$C${r}="","",DATEVALUE(${PROD}!$D${r})*100000000+(${groupSpend(r)})*10000+(5000-ROW()))`;
  // SRCN(U): product row of the (ROW()-1)-th largest key → drives the reverse/sorted mirror
  plan[SRCN] = r => `=IFERROR(MATCH(LARGE($${KEY}$2:$${KEY}$5000,ROW()-1),$${KEY}$2:$${KEY}$5000,0),"")`;
  plan['V'] = r => `=IF($${gCol}${r}="","",IF(AND(N($${eCol}${r})=0,N($${sCol}${r})=0),0,1))`;
  // integer-format columns (counts that should show no decimals)
  const intCols = ['新增用户', '活跃用户', '总用户数', '总启动次数'].map(n => nameToLetter[n]).filter(Boolean);
  return { plan, dateCol: dCol, roasCol: nameToLetter['广告收入 ROAS (TikTok)'], intCols };
}

async function getProductDataCount(token) {
  // Read header-query row count, then count non-empty C column
  let count = 0, startRow = 2;
  while (true) {
    const r = await feishuReq('GET',
      `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values/c50205!C${startRow}:C${startRow + 499}`, token);
    const rows = r.data?.valueRange?.values || [];
    if (!rows.length) break;
    let has = false;
    for (const row of rows) { if (row[0] != null && row[0] !== '') { count++; has = true; } }
    if (!has || rows.length < 500) break;
    startRow += 500;
  }
  return count;
}

// Write formulas for report rows 2..targetRow (header in row 1)
async function writeFormulas(token, targetRow, plan) {
  for (const [col, gen] of Object.entries(plan)) {
    const values = [];
    for (let r = 2; r <= targetRow; r++) values.push([{ type: 'formula', text: gen(r) }]);
    // batch by 200 rows to keep request bodies reasonable
    const BATCH = 200;
    for (let i = 0; i < values.length; i += BATCH) {
      const chunk = values.slice(i, i + BATCH);
      const startR = 2 + i;
      const endR = startR + chunk.length - 1;
      const res = await feishuReq('PUT',
        `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values`, token,
        { valueRange: { range: `${REPORT_SHEET_ID}!${col}${startR}:${col}${endR}`, values: chunk } });
      if (res.code !== 0) throw new Error(`write ${col}${startR}: ${JSON.stringify(res)}`);
    }
    process.stdout.write(`\r  col ${col} done`);
  }
  process.stdout.write('\n');
}

// Apply number formats: B=date, F=percent.
// NOTE: Feishu style API only accepts "0%" or "0.00%" for percent — 1-digit
// ("0.0%") is rejected, so we use 2-digit here to keep F numeric/sortable.
async function applyFormats(token, targetRow, dateCol, roasCol, intCols = []) {
  const setFmt = (range, formatter) => feishuReq('PUT',
    `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/style`, token,
    { appendStyle: { range, style: { formatter } } });
  if (dateCol) {
    const r = await setFmt(`${REPORT_SHEET_ID}!${dateCol}2:${dateCol}${targetRow}`, 'yyyy/MM/dd');
    if (r.code !== 0) console.warn('  [warn] date fmt:', JSON.stringify(r).slice(0, 120));
  }
  if (roasCol) {
    const r = await setFmt(`${REPORT_SHEET_ID}!${roasCol}2:${roasCol}${targetRow}`, '0.00%');
    if (r.code !== 0) console.warn('  [warn] roas fmt:', JSON.stringify(r).slice(0, 120));
  }
  for (const c of intCols) {
    const r = await setFmt(`${REPORT_SHEET_ID}!${c}2:${c}${targetRow}`, '0');
    if (r.code !== 0) console.warn(`  [warn] int fmt ${c}:`, JSON.stringify(r).slice(0, 120));
  }
}

// Hide helper columns U(_srcN) V(_show) W(_key) — indices 20..22 (0-based).
async function hideHelperCols(token) {
  const r = await feishuReq('PUT',
    `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/dimension_range`, token,
    { dimension: { sheetId: REPORT_SHEET_ID, majorDimension: 'COLUMNS', startIndex: 20, endIndex: 23 },
      dimensionProperties: { visible: false } });
  if (r.code !== 0) console.warn('  [warn] hide U:W:', JSON.stringify(r).slice(0, 120));
}

// Show only rows where _show (col V) > 0, i.e. hide rows whose 消耗 AND 广告总收入 are both 0.
// A sheet holds at most one filter: PUT-update its V condition if it exists,
// otherwise POST-create. (POST on an existing filter returns a misleading 1315203.)
async function applyFilter(token, targetRow) {
  const cond = { filter_type: 'number', compare_type: 'greater', expected: ['0'] };
  const base = `/open-apis/sheets/v3/spreadsheets/${SPREADSHEET_TOKEN}/sheets/${REPORT_SHEET_ID}/filter`;
  const g = await feishuReq('GET', base, token).catch(() => ({}));
  const exists = g?.data?.sheet_filter_info?.filter_infos?.length > 0;
  let r;
  if (exists) {
    r = await feishuReq('PUT', base, token, { col: 'V', condition: cond });
  } else {
    r = await feishuReq('POST', base, token, { range: `${REPORT_SHEET_ID}!A1:V${targetRow}`, col: 'V', condition: cond });
  }
  if (r.code !== 0) console.warn('  [warn] set filter:', JSON.stringify(r).slice(0, 150));
}

async function ensureReportFormulas(token) {
  const { getGroupMapping, EXTRA_GROUP_MAP } = require('./build-summaries');
  const header = await readHeader(token);
  const { groups, groupGames } = await getGroupMapping(token);
  // merge extra games into their group IF that group exists in the product table
  const reportGroupGames = {};
  for (const g of groups) reportGroupGames[g] = [...groupGames[g]];
  for (const [game, grp] of Object.entries(EXTRA_GROUP_MAP)) {
    if (reportGroupGames[grp] && !reportGroupGames[grp].includes(game)) reportGroupGames[grp].push(game);
  }
  const { plan, dateCol, roasCol, intCols } = buildPlan(header, reportGroupGames);
  const dataCount = await getProductDataCount(token);
  const targetRow = dataCount + 1 + ROW_BUFFER; // +1 header offset
  console.log(`  product data rows: ${dataCount}, filling report rows 2..${targetRow}`);
  // headers for helper cols U(_srcN) V(_show) W(_key)
  await feishuReq('PUT', `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values`, token,
    { valueRange: { range: `${REPORT_SHEET_ID}!U1:W1`, values: [['_srcN', '_show', '_key']] } });
  const { applyColumnFormats } = require('./build-summaries');
  await writeFormulas(token, targetRow, plan);
  await applyColumnFormats(token, REPORT_SHEET_ID, header, targetRow);
  await applyFilter(token, targetRow);
  await hideHelperCols(token);
  return targetRow;
}

async function main() {
  const token = await getFeishuToken();
  console.log('Building 产品经营日报表...');
  const target = await ensureReportFormulas(token);
  console.log(`Done. Report filled to row ${target}.`);
}

if (require.main === module) {
  main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
}

module.exports = { ensureReportFormulas, getFeishuToken };
