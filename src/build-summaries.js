/**
 * Build 日经营数据汇总 (wAsSso) — pure-formula, one row per day, newest on top.
 *
 * The date column is a reverse sequence MAX(产品数据原表!D) - offset, so no
 * dedup/sort is needed (dates are inherently ordered). Daily and cumulative
 * 消耗/收入 aggregate from 投放数据原表 / 产品数据原表 via SUMIFS.
 *
 * Formulas are placed by HEADER NAME so reordering columns can't misalign.
 *
 * Run standalone:  node src/build-summaries.js
 * Reused daily:    product-api.js calls ensureDailySummary() after import.
 */

const https = require('https');

const SPREADSHEET_TOKEN = 'J8mswO2vziyIAAkdt4rcVeaDnog';
const SUMMARY_SHEET_ID  = 'wAsSso'; // 日经营数据汇总
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

function colLetter(n) { let c = ''; while (n > 0) { const r = (n - 1) % 26; c = String.fromCharCode(65 + r) + c; n = Math.floor((n - 1) / 26); } return c; }

async function readHeader(token, sheetId) {
  const r = await feishuReq('GET',
    `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values/${sheetId}!A1:AZ1`, token);
  return (r.data?.valueRange?.values?.[0] || []).map(v => (v == null ? '' : String(v).trim()));
}

// Spreadsheet date serial (1899-12-30 epoch) from a "YYYY-MM-DD" text date.
function dateToSerial(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(text));
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  return Math.round(ms / 86400000) + 25569;
}

// Scan 产品数据原表!D, return { dayCount, maxSerial, minSerial }.
// 产品数据原表!D holds TEXT dates, so Feishu MAX/DATEVALUE-over-range fails to
// array-evaluate; we compute the serials here and write them as plain values.
async function getProductDateInfo(token) {
  const days = new Set();
  let maxS = -Infinity, minS = Infinity, startRow = 2;
  while (true) {
    const r = await feishuReq('GET',
      `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values/c50205!D${startRow}:D${startRow + 499}`, token);
    const rows = r.data?.valueRange?.values || [];
    if (!rows.length) break;
    let has = false;
    for (const row of rows) {
      const v = row[0];
      if (v != null && v !== '') {
        days.add(String(v)); has = true;
        const s = dateToSerial(v);
        if (s != null) { if (s > maxS) maxS = s; if (s < minS) minS = s; }
      }
    }
    if (!has || rows.length < 500) break;
    startRow += 500;
  }
  return { dayCount: days.size, maxSerial: isFinite(maxS) ? maxS : 0, minSerial: isFinite(minS) ? minS : 0 };
}

// Helper cells (far column) hold the max/min date serial of the product table.
// 产品数据原表!D is a TEXT date ("YYYY-MM-DD"), so we DATEVALUE it to a serial.
const HELP_MAX = 'AX1', HELP_MIN = 'AX2';

// Build { columnLetter -> generator(r) } for 日经营数据汇总 by header name.
function buildPlan(header) {
  const L = {};
  header.forEach((name, j) => { if (name && !L[name]) L[name] = colLetter(j + 1); });
  const dCol = L['统计周期'];
  if (!dCol) throw new Error('日经营数据汇总缺少表头: 统计周期');
  const spendCol = L['消耗'], revCol = L['广告总收入'], cumSpendCol = L['累计消耗'], cumRevCol = L['累计收入'];
  const PD = `${PROD}!$D$2:$D$5000`, PAB = `${PROD}!$AB$2:$AB$5000`, PE = `${PROD}!$E$2:$E$5000`;
  const AE = `${ADS}!$E$2:$E$5000`, AD = `${ADS}!$D$2:$D$5000`;
  const dtxt = r => `TEXT($${dCol}${r},"yyyy-MM-dd")`;   // this row's date as text (产品/投放 D are text)
  const guard = (r, body) => `=IF($${dCol}${r}="","",${body})`;

  const FIELD = {
    // reverse date sequence from helper max serial; blank past the earliest day
    '统计周期': r => `=IF(($${HELP_MAX}-ROW()+2)<$${HELP_MIN},"",$${HELP_MAX}-ROW()+2)`,
    '消耗': r => guard(r, `SUMIFS(${AE},${AD},${dtxt(r)})`),
    '广告总收入': r => guard(r, `SUMIFS(${PAB},${PD},${dtxt(r)})`),
    '当日广告收入 ROAS (TikTok)': r => guard(r, `IFERROR($${revCol}${r}/$${spendCol}${r},"")`),
    // cumulative = this day + the cumulative of the next (older) row. Rows are
    // date-descending, so row r+1 is an earlier day; SUMIFS "<=" on text dates
    // doesn't work in Feishu, so we recurse instead.
    '累计消耗': r => guard(r, `$${spendCol}${r}+N($${cumSpendCol}${r + 1})`),
    '累计收入': r => guard(r, `$${revCol}${r}+N($${cumRevCol}${r + 1})`),
    'TT累计ROI': r => guard(r, `IFERROR($${cumRevCol}${r}/$${cumSpendCol}${r},"")`),
    '新增用户': r => guard(r, `SUMIFS(${PE},${PD},${dtxt(r)})`),
  };
  const plan = {};
  header.forEach((name, j) => { if (FIELD[name]) plan[colLetter(j + 1)] = FIELD[name]; });
  return { plan, dateCol: dCol, roasCols: [L['当日广告收入 ROAS (TikTok)'], L['TT累计ROI']].filter(Boolean) };
}

async function writeFormulas(token, sheetId, targetRow, plan) {
  for (const [col, gen] of Object.entries(plan)) {
    const values = [];
    for (let r = 2; r <= targetRow; r++) values.push([{ type: 'formula', text: gen(r) }]);
    const BATCH = 200;
    for (let i = 0; i < values.length; i += BATCH) {
      const chunk = values.slice(i, i + BATCH);
      const startR = 2 + i, endR = startR + chunk.length - 1;
      const res = await feishuReq('PUT',
        `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values`, token,
        { valueRange: { range: `${sheetId}!${col}${startR}:${col}${endR}`, values: chunk } });
      if (res.code !== 0) throw new Error(`write ${col}${startR}: ${JSON.stringify(res)}`);
    }
    process.stdout.write(`\r  col ${col} done`);
  }
  process.stdout.write('\n');
}

async function applyFormats(token, sheetId, targetRow, dateCol, roasCols) {
  const setFmt = (range, formatter) => feishuReq('PUT',
    `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/style`, token,
    { appendStyle: { range, style: { formatter } } });
  if (dateCol) {
    const r = await setFmt(`${sheetId}!${dateCol}2:${dateCol}${targetRow}`, 'yyyy/MM/dd');
    if (r.code !== 0) console.warn('  [warn] date fmt:', JSON.stringify(r).slice(0, 120));
  }
  for (const c of roasCols) {
    const r = await setFmt(`${sheetId}!${c}2:${c}${targetRow}`, '0.00%');
    if (r.code !== 0) console.warn(`  [warn] roas fmt ${c}:`, JSON.stringify(r).slice(0, 120));
  }
}

async function ensureDailySummary(token) {
  const header = await readHeader(token, SUMMARY_SHEET_ID);
  const { plan, dateCol, roasCols } = buildPlan(header);
  const { dayCount, maxSerial, minSerial } = await getProductDateInfo(token);
  const targetRow = dayCount + 1 + ROW_BUFFER;
  console.log(`  日经营数据汇总: ${dayCount} 天 (serial ${minSerial}..${maxSerial}), 填充 2..${targetRow}`);
  // write helper max/min date serial as plain numbers
  await feishuReq('PUT', `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values`, token, {
    valueRange: { range: `${SUMMARY_SHEET_ID}!${HELP_MAX}:${HELP_MIN}`,
      values: [[maxSerial], [minSerial]] } });
  await writeFormulas(token, SUMMARY_SHEET_ID, targetRow, plan);
  await applyFormats(token, SUMMARY_SHEET_ID, targetRow, dateCol, roasCols);
  // hide helper column AX (index 49)
  await feishuReq('PUT', `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/dimension_range`, token,
    { dimension: { sheetId: SUMMARY_SHEET_ID, majorDimension: 'COLUMNS', startIndex: 49, endIndex: 50 },
      dimensionProperties: { visible: false } }).catch(() => {});
  return targetRow;
}

// ─── 项目维度经营表 (JIKPZV) ────────────────────────────────────────────────
// One row per (day × 项目组); within a day, 项目组 sorted by 消耗 descending.
// Helper columns hold each fixed group's daily/cumulative 消耗; the visible
// columns pick the rank-th highest via LARGE/MATCH. 产品 metrics use 产品表's
// 项目组 column directly; 投放 metrics map game→group via array MATCH.

const PROJECT_SHEET_ID = 'JIKPZV';

// Read 产品数据原表 B(项目组) C(游戏) → ordered groups + group→games map.
async function getGroupMapping(token) {
  const groups = [];
  const groupGames = {};
  let startRow = 2;
  while (true) {
    const r = await feishuReq('GET',
      `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values/c50205!B${startRow}:C${startRow + 499}`, token);
    const rows = r.data?.valueRange?.values || [];
    if (!rows.length) break;
    let has = false;
    for (const row of rows) {
      const grp = row[0], game = row[1];
      if (grp && game) {
        has = true;
        if (!groupGames[grp]) { groupGames[grp] = []; groups.push(grp); }
        if (!groupGames[grp].includes(game)) groupGames[grp].push(game);
      }
    }
    if (!has || rows.length < 500) break;
    startRow += 500;
  }
  return { groups, groupGames };
}

async function ensureProjectSummary(token) {
  const header = await readHeader(token, PROJECT_SHEET_ID);
  const L = {};
  header.forEach((name, j) => { if (name && !L[name]) L[name] = colLetter(j + 1); });
  const need = n => { if (!L[n]) throw new Error(`项目维度经营表缺少表头: ${n}`); return L[n]; };
  const aCol = need('项目组'), bCol = need('统计周期'), cCol = need('消耗'), dCol = need('广告总收入'),
        eCol = need('当日广告收入 ROAS (TikTok)'), fCol = need('累计消耗'), gCol = need('累计收入'),
        hCol = need('TT累计ROI'), iCol = need('新增用户');

  const { dayCount, maxSerial, minSerial } = await getProductDateInfo(token);
  const { groups, groupGames } = await getGroupMapping(token);
  const N = groups.length;
  if (N === 0) throw new Error('无项目组');
  const targetRow = dayCount * N + 1 + ROW_BUFFER;
  console.log(`  项目维度经营表: ${dayCount} 天 × ${N} 组, 填充 2..${targetRow}`);

  // helper columns: today spend (N) then cumulative spend (N), starting at col 18 (R)
  const TODAY0 = 18;                       // R
  const CUM0 = TODAY0 + N;                  // R+N
  const todayCols = Array.from({ length: N }, (_, k) => colLetter(TODAY0 + k));
  const cumCols = Array.from({ length: N }, (_, k) => colLetter(CUM0 + k));
  const HMAX = 'BA1', HMIN = 'BA2';
  const MAXC = `$${HMAX}`, MINC = `$${HMIN}`;

  const PD = `${PROD}!$D$2:$D$5000`, PAB = `${PROD}!$AB$2:$AB$5000`, PE = `${PROD}!$E$2:$E$5000`, PB = `${PROD}!$B$2:$B$5000`;
  const AE = `${ADS}!$E$2:$E$5000`, AD = `${ADS}!$D$2:$D$5000`, AB = `${ADS}!$B$2:$B$5000`;
  const gamesArr = groups.map(g => `{${groupGames[g].map(x => `"${x.replace(/"/g, '""')}"`).join(',')}}`);
  const groupsArr = `{${groups.map(g => `"${g}"`).join(',')}}`;

  const dser = r => `(${MAXC}-INT((${r}-2)/${N}))`;          // this row's date serial
  const invalid = r => `${dser(r)}<${MINC}`;
  const dtxt = r => `TEXT(${dser(r)},"yyyy-MM-dd")`;
  const rank = r => `(MOD(${r}-2,${N})+1)`;
  const todayRange = r => `$${todayCols[0]}${r}:$${todayCols[N - 1]}${r}`;
  const cumRange = r => `$${cumCols[0]}${r}:$${cumCols[N - 1]}${r}`;
  const ifGrp = (r, body) => `=IF($${aCol}${r}="","",${body})`;  // guard on 项目组 resolved

  const plan = {};
  // helper: today spend per fixed group k
  todayCols.forEach((col, k) => {
    plan[col] = r => `=IF(${invalid(r)},"",SUM(SUMIFS(${AE},${AB},${gamesArr[k]},${AD},${dtxt(r)})))`;
  });
  // helper: cumulative spend per fixed group k (game∈group AND date<=)
  cumCols.forEach((col, k) => {
    plan[col] = r => `=IF(${invalid(r)},"",SUMPRODUCT(ISNUMBER(MATCH(${AB},${gamesArr[k]},0))*(DATEVALUE(${AD})<=${dser(r)})*${AE}))`;
  });
  // visible columns by header name
  plan[bCol] = r => `=IF(${invalid(r)},"",${dser(r)})`;                                   // 统计周期
  plan[cCol] = r => `=IF(${invalid(r)},"",LARGE(${todayRange(r)},${rank(r)}))`;           // 消耗 (rank-th highest)
  plan[aCol] = r => `=IF(${invalid(r)},"",INDEX(${groupsArr},MATCH($${cCol}${r},${todayRange(r)},0)))`; // 项目组
  plan[dCol] = r => ifGrp(r, `SUMIFS(${PAB},${PB},$${aCol}${r},${PD},${dtxt(r)})`);       // 广告总收入
  plan[eCol] = r => ifGrp(r, `IFERROR($${dCol}${r}/$${cCol}${r},"")`);                    // 当日 ROAS
  plan[fCol] = r => ifGrp(r, `INDEX(${cumRange(r)},MATCH($${aCol}${r},${groupsArr},0))`); // 累计消耗
  plan[gCol] = r => ifGrp(r, `SUMPRODUCT((${PB}=$${aCol}${r})*(DATEVALUE(${PD})<=${dser(r)})*${PAB})`); // 累计收入
  plan[hCol] = r => ifGrp(r, `IFERROR($${gCol}${r}/$${fCol}${r},"")`);                    // 累计 ROI
  plan[iCol] = r => ifGrp(r, `SUMIFS(${PE},${PB},$${aCol}${r},${PD},${dtxt(r)})`);        // 新增用户

  // write max/min serial helper values
  await feishuReq('PUT', `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values`, token,
    { valueRange: { range: `${PROJECT_SHEET_ID}!${HMAX}:${HMIN}`, values: [[maxSerial], [minSerial]] } });
  await writeFormulas(token, PROJECT_SHEET_ID, targetRow, plan);
  await applyFormats(token, PROJECT_SHEET_ID, targetRow, bCol, [eCol, hCol]);
  // hide helper columns (today+cum) and the serial helper col BA(52)
  await feishuReq('PUT', `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/dimension_range`, token,
    { dimension: { sheetId: PROJECT_SHEET_ID, majorDimension: 'COLUMNS', startIndex: TODAY0 - 1, endIndex: CUM0 + N - 1 },
      dimensionProperties: { visible: false } }).catch(() => {});
  await feishuReq('PUT', `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/dimension_range`, token,
    { dimension: { sheetId: PROJECT_SHEET_ID, majorDimension: 'COLUMNS', startIndex: 52, endIndex: 53 },
      dimensionProperties: { visible: false } }).catch(() => {});
  return targetRow;
}

async function main() {
  const token = await getFeishuToken();
  const which = process.env.ONLY || 'all';
  if (which === 'all' || which === 'daily') {
    console.log('Building 日经营数据汇总...');
    const t = await ensureDailySummary(token);
    console.log(`  done, row ${t}.`);
  }
  if (which === 'all' || which === 'project') {
    console.log('Building 项目维度经营表...');
    const t = await ensureProjectSummary(token);
    console.log(`  done, row ${t}.`);
  }
}

if (require.main === module) {
  main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
}

module.exports = { ensureDailySummary, ensureProjectSummary, getFeishuToken };
