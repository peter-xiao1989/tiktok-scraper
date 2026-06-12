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
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || (() => { throw new Error('FEISHU_APP_SECRET env is required'); })();

// Games that are advertised but absent from 产品数据原表 (no product data), with
// their manually-assigned 项目组. Used to label 项目组 in 投放 dimension tables.
const EXTRA_GROUP_MAP = {
  'Gears Wars': '齿轮',
  'Gear Fight': '齿轮',
  'Ball Strike': '齿轮',
  'Merge Tanks': '战车',
  'Snake': '贪吃蛇',
  'Snake King Battle': '贪吃蛇',
};

function feishuReqOnce(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request({ hostname: 'open.feishu.cn', path, method, headers, timeout: 30000 },
      res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => {
        const d = Buffer.concat(chunks).toString('utf8');  // concat before decode (multibyte-safe)
        try { resolve(JSON.parse(d)); } catch (e) { reject(new Error(`non-JSON: ${d.slice(0, 200)}`)); }
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

// Scan date columns and return { dayCount, maxSerial, minSerial } over the
// UNION of 产品数据原表!D and 投放数据原表!D — so day-keyed tables (日经营汇总,
// 项目维度经营表) get a row for the latest 投放 day even before 产品 data lands.
// Both columns hold TEXT dates, so we compute serials here (Feishu can't
// array-evaluate DATEVALUE over a range).
async function getProductDateInfo(token) {
  const days = new Set();
  let maxS = -Infinity, minS = Infinity;
  for (const sheet of ['c50205', 'uqJEhq']) {
    let startRow = 2;
    while (true) {
      const r = await feishuReq('GET',
        `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values/${sheet}!D${startRow}:D${startRow + 499}`, token);
      const rows = r.data?.valueRange?.values || [];
      if (!rows.length) break;
      let has = false;
      for (const row of rows) {
        const v = row[0];
        if (v != null && v !== '') {
          const s = dateToSerial(v);
          if (s != null) { days.add(s); has = true; if (s > maxS) maxS = s; if (s < minS) minS = s; }
        }
      }
      if (!has || rows.length < 500) break;
      startRow += 500;
    }
  }
  return { dayCount: days.size, maxSerial: isFinite(maxS) ? maxS : 0, minSerial: isFinite(minS) ? minS : 0 };
}

// Build { columnLetter -> generator(r) } for 日经营数据汇总 by header name.
// maxSerial/minSerial are inlined as numeric constants (no helper cells), so
// editing/reordering columns in the sheet can't break a cell reference.
function buildPlan(header, maxSerial, minSerial) {
  const L = {};
  header.forEach((name, j) => { if (name && !L[name]) L[name] = colLetter(j + 1); });
  const dCol = L['统计周期'];
  if (!dCol) throw new Error('日经营数据汇总缺少表头: 统计周期');
  const spendCol = L['消耗'], revCol = L['广告总收入'], cumSpendCol = L['累计消耗'], cumRevCol = L['累计收入'];
  const PD = `${PROD}!$D$2:$D$5000`, PAB = `${PROD}!$AB$2:$AB$5000`, PE = `${PROD}!$E$2:$E$5000`;
  const AE = `${ADS}!$E$2:$E$5000`, AD = `${ADS}!$D$2:$D$5000`, AF = `${ADS}!$F$2:$F$5000`;
  const dtxt = r => `TEXT($${dCol}${r},"yyyy-MM-dd")`;   // this row's date as text (产品/投放 D are text)
  const guard = (r, body) => `=IF($${dCol}${r}="","",${body})`;

  const FIELD = {
    // reverse date sequence from inlined max serial; blank past the earliest day
    '统计周期': r => `=IF((${maxSerial}-ROW()+2)<${minSerial},"",${maxSerial}-ROW()+2)`,
    '消耗': r => guard(r, `SUMIFS(${AE},${AD},${dtxt(r)})`),
    '广告总收入': r => guard(r, `SUMIFS(${PAB},${PD},${dtxt(r)})`),
    '当日广告收入 ROAS (TikTok)': r => guard(r, `IFERROR(SUMPRODUCT((${AD}=${dtxt(r)})*${AE}*${AF})/$${spendCol}${r},"")`),  // 投放原表 ROAS 按消耗加权
    '广告收入 ROAS (TikTok)': r => guard(r, `IFERROR(SUMPRODUCT((${AD}=${dtxt(r)})*${AE}*${AF})/$${spendCol}${r},"")`),      // 同上(表头无"当日"前缀的别名)
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

// Grow the sheet if the plan needs more rows/columns than it has.
async function ensureGrid(token, sheetId, minRows, minCols) {
  const meta = await feishuReq('GET',
    `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/metainfo`, token);
  const sh = (meta.data?.sheets || []).find(x => x.sheetId === sheetId);
  if (!sh) return;
  const addRows = minRows - sh.rowCount, addCols = minCols - sh.columnCount;
  for (const [dim, count] of [['ROWS', addRows], ['COLUMNS', addCols]]) {
    if (count > 0) {
      await feishuReq('POST', `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/dimension_range`, token,
        { dimension: { sheetId, majorDimension: dim, length: count } });
    }
  }
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

// Feishu number/percent formats only support 0 or 2 decimals (1-decimal masks
// rejected). To show 1-decimal numbers we ROUND the value to 1 and clear the
// cell format (Feishu's default then shows the raw value = 1 decimal).
//   date → yyyy/MM/dd ; ROAS/ROI/率 → 0.00% ; counts → #,##0 ; else → 1-decimal.
const FMT_INT_NAMES = new Set([
  '序号', '新增用户', '活跃用户', '重复用户', '有效用户', '总用户数', '总启动次数',
  '展示量', '点击量（目标页面）', '广告请求量', '广告曝光量', '转化量', '应用安装数',
  '活跃度', '广告曝光事件总数', '总打开次数', '去重打开次数',
]);
const FMT_DATE_NAMES = new Set(['统计周期', '按天', '更新时间']);
const FMT_PCT_NAMES = new Set(['次留', '7日留存', '14日留存', '30日留存']);
// Text columns must NOT be wrapped in ROUND (doubles the formula → can exceed
// the 1000-char limit) and must NOT get a number format.
const FMT_TEXT_NAMES = new Set(['项目组', '游戏名称', '创意素材名称', '出价方式', '账户名称', '系列名称']);
function classify(name) {
  const n = (name || '').trim();
  if (FMT_DATE_NAMES.has(n)) return 'date';
  if (FMT_TEXT_NAMES.has(n)) return 'text';
  if (/ROAS|ROI|率|次留|留存/.test(n) || FMT_PCT_NAMES.has(n)) return 'pct';
  if (FMT_INT_NAMES.has(n)) return 'int';
  return 'dec';
}

// Wrap decimal-column formulas with ROUND(.,1) so the value itself is 1-decimal.
function wrapDecimals(plan, header) {
  const colToName = {};
  header.forEach((n, j) => { if (n) colToName[colLetter(j + 1)] = n; });
  for (const col of Object.keys(plan)) {
    const name = colToName[col];
    if (!name || classify(name) !== 'dec') continue;
    const g = plan[col];
    plan[col] = r => { const f = g(r); const body = f.startsWith('=') ? f.slice(1) : f; return `=IFERROR(ROUND(${body},1),${body})`; };
  }
  return plan;
}

// Apply per-column formats by header name (idempotent; re-run daily → permanent).
// dec columns get their format cleared so the ROUND-ed 1-decimal value shows raw.
async function applyColumnFormats(token, sheetId, header, targetRow) {
  for (let j = 0; j < header.length; j++) {
    const name = header[j];
    if (!name) continue;
    const col = colLetter(j + 1);
    const type = classify(name);
    if (type === 'text') continue;  // leave text columns untouched
    const style = type === 'date' ? { formatter: 'yyyy/MM/dd' }
      : type === 'pct' ? { formatter: '0.00%' }
      : type === 'int' ? { formatter: '#,##0' }
      : { formatter: '' };  // dec → general format, shows ROUND-ed 1-decimal value
    const r = await feishuReq('PUT', `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/style`, token,
      { appendStyle: { range: `${sheetId}!${col}2:${col}${targetRow}`, style } });
    if (r.code !== 0) console.warn(`  [warn] fmt ${col}(${name}):`, JSON.stringify(r).slice(0, 100));
  }
}

// ─── 静态值化通用 helper ────────────────────────────────────────────────────
// 源表数字是文本; 读取后在 node 里算值、写纯静态值(无公式 → 源表变动不触发重算)。
const pnum = v => parseFloat(String(v == null ? '' : v).replace(/[,%]/g, '')) || 0;
const ppct = v => { const s = String(v == null ? '' : v); return s.includes('%') ? pnum(s) / 100 : pnum(s); };

// 读 sheet 从 startCol 到 endCol 的所有数据行(行2起,分批)。
async function readColsAll(token, sheetId, startCol, endCol) {
  let out = [], s = 2;
  while (s < 6000) {
    const r = await feishuReq('GET',
      `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values/${sheetId}!${startCol}${s}:${endCol}${s + 499}`, token);
    const rows = r.data?.valueRange?.values || [];
    if (!rows.length) break;
    out = out.concat(rows);
    if (rows.length < 500) break;
    s += 500;
  }
  return out;
}

// 写静态值二维数组,并把多余旧行写空(飞书无 batch_clear; 用 PUT 写空覆盖公式残留)。
async function writeStaticGrid(token, sheetId, header, grid, clearRows) {
  const endCol = colLetter(header.length);
  const BATCH = 200;
  const put = (startR, chunk) => feishuReq('PUT',
    `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values`, token,
    { valueRange: { range: `${sheetId}!A${startR}:${endCol}${startR + chunk.length - 1}`, values: chunk } });
  for (let i = 0; i < grid.length; i += BATCH) {
    const r = await put(2 + i, grid.slice(i, i + BATCH));
    if (r.code !== 0) throw new Error(`write static ${2 + i}: ${JSON.stringify(r)}`);
    process.stdout.write(`\r  wrote ${Math.min(i + BATCH, grid.length)}/${grid.length}`);
  }
  // 清空 grid 之后到 clearRows 的旧行(写空字符串覆盖公式)
  for (let r = 2 + grid.length; r <= clearRows; r += BATCH) {
    const end = Math.min(r + BATCH - 1, clearRows);
    const empty = Array.from({ length: end - r + 1 }, () => Array(header.length).fill(''));
    const res = await put(r, empty);
    if (res.code !== 0) throw new Error(`blank ${r}: ${JSON.stringify(res)}`);
  }
  process.stdout.write('\n');
}

// 清空 fromColNum(1-based)..BZ 的旧 helper 公式(写空),解除其对源表的依赖。
async function clearTrailingCols(token, sheetId, fromColNum, rows) {
  const startCol = colLetter(fromColNum), endCol = 'BZ', ncol = 78 - fromColNum + 1;
  if (ncol <= 0) return;
  const BATCH = 200;
  for (let r = 2; r <= rows; r += BATCH) {
    const end = Math.min(r + BATCH - 1, rows);
    const empty = Array.from({ length: end - r + 1 }, () => Array(ncol).fill(''));
    const res = await feishuReq('PUT', `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values`, token,
      { valueRange: { range: `${sheetId}!${startCol}${r}:${endCol}${end}`, values: empty } });
    if (res.code !== 0) throw new Error(`clear helper ${r}: ${JSON.stringify(res)}`);
  }
}

// 日经营数据汇总 — node 算静态值(按日期聚合),不写公式。
async function ensureDailySummary(token) {
  const header = await readHeader(token, SUMMARY_SHEET_ID);
  const adsRows  = await readColsAll(token, 'uqJEhq', 'D', 'F');   // D日期 E消耗 F ROAS
  const prodRows = await readColsAll(token, 'c50205', 'D', 'AB');  // D日期 E新增 … AB收入(idx24)
  const by = {};
  const g = d => (by[d] = by[d] || { spend: 0, rev: 0, rn: 0, nu: 0 });
  adsRows.forEach(r => { const d = r[0]; if (!d) return; const e = pnum(r[1]); g(d).spend += e; g(d).rn += e * ppct(r[2]); });
  prodRows.forEach(r => { const d = r[0]; if (!d) return; g(d).nu += pnum(r[1]); g(d).rev += pnum(r[24]); });

  const dates = Object.keys(by).filter(d => dateToSerial(d)).sort((a, b) => dateToSerial(b) - dateToSerial(a));
  // 累计:从旧到新累加
  const cum = {}; let cS = 0, cR = 0;
  [...dates].reverse().forEach(d => { cS += by[d].spend; cR += by[d].rev; cum[d] = { s: cS, r: cR }; });

  const r1 = v => Math.round(v * 10) / 10;
  const cellOf = (name, d) => {
    const x = by[d], c = cum[d];
    switch (name) {
      case '统计周期': return dateToSerial(d);
      case '消耗': return r1(x.spend);
      case '广告总收入': return r1(x.rev);
      case '当日广告收入 ROAS (TikTok)':
      case '广告收入 ROAS (TikTok)': return x.spend ? x.rn / x.spend : '';   // 原值,0.00% 格式显示
      case '累计消耗': return r1(c.s);
      case '累计收入': return r1(c.r);
      case 'TT累计ROI': return c.s ? c.r / c.s : '';
      case '新增用户': return Math.round(x.nu);
      default: return '';
    }
  };
  const grid = dates.map(d => header.map(name => (name ? cellOf(name, d) : '')));
  const clearRows = dates.length + 1 + ROW_BUFFER;
  console.log(`  日经营数据汇总(静态值): ${dates.length} 天, 写 2..${dates.length + 1}`);
  await writeStaticGrid(token, SUMMARY_SHEET_ID, header, grid, clearRows);
  await applyColumnFormats(token, SUMMARY_SHEET_ID, header, dates.length + 1);
  return dates.length + 1;
}

// ─── 项目维度经营表 (JIKPZV) ────────────────────────────────────────────────
// One row per (day × 项目组); within a day, 项目组 sorted by 消耗 descending.
// Helper columns hold each fixed group's daily/cumulative 消耗; the visible
// columns pick the rank-th highest via LARGE/MATCH. 产品 metrics use 产品表's
// 项目组 column directly; 投放 metrics map game→group via array MATCH.

const PROJECT_SHEET_ID = 'JIKPZV';

// Read 产品id及链接 A(项目组) B(产品名) → ordered groups + group→games map.
// (User-maintained roster; covers 投放-only groups like 齿轮/战车 that never
// appear in 产品数据原表.)
async function getGroupMapping(token) {
  const groups = [];
  const groupGames = {};
  {
    const r = await feishuReq('GET',
      `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values/juQobR!A2:B200`, token);
    const rows = r.data?.valueRange?.values || [];
    for (const row of rows) {
      const grp = row[0], game = row[1];
      if (grp && game) {
        if (!groupGames[grp]) { groupGames[grp] = []; groups.push(grp); }
        if (!groupGames[grp].includes(game)) groupGames[grp].push(game);
      }
    }
  }
  // game → group from product table (product groups only)
  const gameToGroup = {};
  for (const grp of groups) for (const g of groupGames[grp]) gameToGroup[g] = grp;
  return { groups, groupGames, gameToGroup };
}

// node 算静态值:每行(日期×组),同日组按消耗降序。消耗=投放原表按 game→group 聚合;
// 收入/新增=产品原表按项目组聚合;累计=组内按日期累加。无公式 → 源表变动不重算。
async function ensureProjectSummary(token) {
  let header = await readHeader(token, PROJECT_SHEET_ID);
  const WANT_BID = ['手动出价消耗', '手动出价ROI', '自动出价消耗', '自动出价ROI',
    '广告请求量', '广告曝光量', '广告点击量', '广告点击率', 'eCPM', '人均广告展示次数',
    '总启动次数', '人均进入次数', '每位用户平均时长(分)', '次均游戏时长(分)',
    '平均启动速度(秒)', '平均首次启动速度(秒)', '启动成功率', '授权成功率',
    '次留', '7日留存', '14日留存', '30日留存', '活跃用户', '活跃度平均成本', '人均广告次数'];
  {
    const missing = WANT_BID.filter(n => !header.includes(n));
    if (missing.length) {
      header = [...header.filter(Boolean), ...missing];
      await feishuReq('PUT', `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values`, token,
        { valueRange: { range: `${PROJECT_SHEET_ID}!A1:${colLetter(header.length)}1`, values: [header] } });
    }
  }
  const { groups, gameToGroup } = await getGroupMapping(token);
  if (!groups.length) throw new Error('无项目组');
  const adsRows  = await readColsAll(token, 'uqJEhq', 'B', 'AT');  // B游戏0 D日期2 E消耗3 F_ROAS4 AT出价44
  const prodRows = await readColsAll(token, 'c50205', 'B', 'AB');  // B组0 D日期2 E新增3 AB收入26

  const by = {};  // "date|group" -> {sp,rn,rev,nu,mSp,mRn,aSp,aRn}
  const cell = (d, grp) => (by[`${d}|${grp}`] = by[`${d}|${grp}`] || { sp: 0, rn: 0, rev: 0, nu: 0, mSp: 0, mRn: 0, aSp: 0, aRn: 0, act: 0, adAct: 0, gross: 0, eng: 0, launch: 0, req: 0, expo: 0, clk: 0, entW: 0, durW: 0, sesW: 0, spdW: 0, fspdW: 0, srW: 0, authW: 0, r1W: 0, r7W: 0, r14W: 0, r30W: 0 });
  adsRows.forEach(r => {
    const game = r[0], d = r[2]; if (!game || !d) return;
    const grp = gameToGroup[game]; if (!grp) return;
    const e = pnum(r[3]); const c = cell(d, grp); c.sp += e; c.rn += e * ppct(r[4]); c.adAct += pnum(r[5]);
    const gross = pnum(r[28]), apc = pnum(r[7]);
    c.gross += gross; if (apc > 0) c.eng += gross / apc;
    if (r[44] === '手动出价') { c.mSp += e; c.mRn += e * ppct(r[4]); }
    else if (r[44] === '自动出价') { c.aSp += e; c.aRn += e * ppct(r[4]); }
  });
  prodRows.forEach(r => {
    const grp = r[0], d = r[2]; if (!grp || !d) return;
    const c = cell(d, grp); c.rev += pnum(r[26]); c.nu += pnum(r[3]);
    const act = pnum(r[4]), nu = pnum(r[3]);
    c.act += act; c.launch += pnum(r[8]); c.req += pnum(r[20]); c.expo += pnum(r[21]); c.clk += pnum(r[22]);
    c.entW += pnum(r[9]) * act; c.durW += pnum(r[10]) * act; c.sesW += pnum(r[11]) * act;
    c.spdW += pnum(r[12]) * act; c.fspdW += pnum(r[13]) * act;
    c.srW += ppct(r[14]) * act; c.authW += ppct(r[15]) * act;
    c.r1W += ppct(r[16]) * nu; c.r7W += ppct(r[17]) * nu; c.r14W += ppct(r[18]) * nu; c.r30W += ppct(r[19]) * nu;
  });

  const dates = [...new Set(Object.keys(by).map(k => k.split('|')[0]))]
    .filter(d => dateToSerial(d)).sort((a, b) => dateToSerial(b) - dateToSerial(a));
  const cum = {};  // cumulative per group over dates (ascending)
  for (const grp of groups) {
    let cS = 0, cR = 0;
    [...dates].reverse().forEach(d => {
      const x = by[`${d}|${grp}`] || { sp: 0, rev: 0 };
      cS += x.sp; cR += x.rev; cum[`${d}|${grp}`] = { s: cS, r: cR };
    });
  }
  const rows = [];  // each date × N groups, sorted by 消耗 desc within the day
  dates.forEach(d => {
    groups.map(grp => ({ grp, date: d, ...(by[`${d}|${grp}`] || cell('-tmp-', '-tmp-')), c: cum[`${d}|${grp}`] || { s: 0, r: 0 } }))
      .sort((a, b) => b.sp - a.sp).forEach(g => rows.push(g));
  });

  const r1 = v => Math.round(v * 10) / 10;
  const cellOf = (name, row, seq) => {
    switch (name) {
      case '序号': return seq;
      case '项目组': return row.grp;
      case '统计周期': return dateToSerial(row.date);
      case '消耗': return r1(row.sp);
      case '广告总收入': return r1(row.rev);
      case '当日广告收入 ROAS (TikTok)': case '广告收入 ROAS (TikTok)': return row.sp ? row.rn / row.sp : '';
      case '项目累计消耗': case '累计消耗': return r1(row.c.s);
      case '项目累计收入': case '累计收入': return r1(row.c.r);
      case '项目累计ROI': case 'TT累计ROI': return row.c.s ? row.c.r / row.c.s : '';
      case '新增用户': return Math.round(row.nu);
      case '手动出价消耗': return row.mSp ? r1(row.mSp) : '';
      case '手动出价ROI': return row.mSp ? row.mRn / row.mSp : '';
      case '自动出价消耗': return row.aSp ? r1(row.aSp) : '';
      case '自动出价ROI': return row.aSp ? row.aRn / row.aSp : '';
      case '广告请求量': return row.req ? Math.round(row.req) : '';
      case '广告曝光量': return row.expo ? Math.round(row.expo) : '';
      case '广告点击量': return row.clk ? Math.round(row.clk) : '';
      case '广告点击率': return row.expo ? row.clk / row.expo : '';
      case 'eCPM': return row.expo ? r1(row.rev / row.expo * 1000) : '';
      case '人均广告展示次数': return row.act ? r1(row.expo / row.act) : '';
      case '总启动次数': return row.launch ? Math.round(row.launch) : '';
      case '人均进入次数': return row.act ? r1(row.entW / row.act) : '';
      case '每位用户平均时长(分)': return row.act ? r1(row.durW / row.act) : '';
      case '次均游戏时长(分)': return row.act ? r1(row.sesW / row.act) : '';
      case '平均启动速度(秒)': return row.act ? r1(row.spdW / row.act) : '';
      case '平均首次启动速度(秒)': return row.act ? r1(row.fspdW / row.act) : '';
      case '启动成功率': return row.act ? row.srW / row.act : '';
      case '授权成功率': return row.act ? row.authW / row.act : '';
      case '次留': return row.nu ? row.r1W / row.nu : '';
      case '7日留存': return row.nu ? row.r7W / row.nu : '';
      case '14日留存': return row.nu ? row.r14W / row.nu : '';
      case '30日留存': return row.nu ? row.r30W / row.nu : '';
      case '活跃用户': return row.act ? Math.round(row.act) : '';
      case '活跃度平均成本': return row.adAct ? r1(row.sp / row.adAct) : '';
      case '人均广告次数': return row.eng ? r1(row.gross / row.eng) : '';
      default: return '';
    }
  };
  const grid = rows.map((row, i) => header.map(name => (name ? cellOf(name, row, i + 1) : '')));
  const clearRows = rows.length + 1 + ROW_BUFFER;
  console.log(`  项目维度经营表(静态值): ${dates.length}天 × ${groups.length}组 = ${rows.length}行`);
  await writeStaticGrid(token, PROJECT_SHEET_ID, header, grid, clearRows);
  await clearTrailingCols(token, PROJECT_SHEET_ID, header.length + 1, clearRows);  // 清旧 helper 公式
  await applyColumnFormats(token, PROJECT_SHEET_ID, header, rows.length + 1);
  return rows.length + 1;
}

// ─── 投放日表-产品维度 (kX0M0R) ─────────────────────────────────────────────
// One row per (day × game) from 投放数据原表 (ad-level → deduped to game-level),
// sorted by a composite key DATEVALUE(date)*1e7 + game-day 消耗, descending, so
// newest day is on top and within a day higher 消耗 is on top. 消耗=0 excluded.

const AD_PRODUCT_SHEET_ID = 'kX0M0R';

// Scan 投放数据原表 → ad row count + count of (date|game) with positive spend.
async function getAdProductInfo(token) {
  const spend = {};
  let rowCount = 0, startRow = 2;
  while (true) {
    const r = await feishuReq('GET',
      `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values/uqJEhq!B${startRow}:E${startRow + 499}`, token);
    const rows = r.data?.valueRange?.values || [];
    if (!rows.length) break;
    let has = false;
    for (const row of rows) {
      const g = row[0], d = row[2], e = parseFloat(row[3]) || 0;
      if (g && d) { has = true; rowCount++; const k = `${d}|${g}`; spend[k] = (spend[k] || 0) + e; }
    }
    if (!has || rows.length < 500) break;
    startRow += 500;
  }
  const posCount = Object.values(spend).filter(v => v > 0).length;
  return { adRowCount: rowCount, posCount };
}

// node 算静态值:按(日期×游戏)聚合投放数据,消耗>0,日期降序+同日消耗降序。
// 人均广告次数 = Σgross / Σengaged(engaged = gross/投放!I 反推)。无公式。
async function ensureAdProductSummary(token) {
  let header = await readHeader(token, AD_PRODUCT_SHEET_ID);
  // 表头维护:旧"项目累计*"改名"产品累计*";缺的追加
  const HDR_REN = { '项目累计消耗': '产品累计消耗', '项目累计收入': '产品累计收入', '项目累计ROI': '产品累计ROI' };
  const WANT = ['产品累计消耗', '产品累计收入', '产品累计ROI', '信号', '手动出价消耗', '手动出价ROI', '自动出价消耗', '自动出价ROI'];
  const renamed = header.map(h => HDR_REN[h] || h);
  const missing = WANT.filter(n => !renamed.includes(n));
  const newHeader = [...renamed.filter(Boolean), ...missing];
  if (JSON.stringify(newHeader) !== JSON.stringify(header.filter(Boolean))) {
    header = newHeader;
    await feishuReq('PUT', `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values`, token,
      { valueRange: { range: `${AD_PRODUCT_SHEET_ID}!A1:${colLetter(header.length)}1`, values: [header] } });
  } else header = newHeader;
  const { gameToGroup } = await getGroupMapping(token);
  const fullMap = { ...gameToGroup, ...EXTRA_GROUP_MAP };
  // 宽松日期解析:文本日期(2026-06-10/2026/6/1)或纯数字 serial
  const serAny = s => {
    const str = String(s == null ? '' : s).trim();
    if (/^\d{5}(\.\d+)?$/.test(str)) return Math.round(+str);
    const m = /(\d{4})[/-](\d{1,2})[/-](\d{1,2})/.exec(str);
    return m ? Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 864e5) + 25569 : null;
  };
  const ad = await readColsAll(token, 'uqJEhq', 'B', 'AT');  // B游戏0 D日期2 E消耗3 F4 G活跃度5 I人均次数7 AD_gross28 AT出价44
  const prod = await readColsAll(token, 'c50205', 'C', 'AB'); // C游戏0 D日期1 … AB收入25
  const revMap = {};  // serial|game → 广告总收入(产品表)
  prod.forEach(r => { const s = serAny(r[1]); if (r[0] && s) revMap[`${s}|${r[0]}`] = pnum(r[25]); });

  const by = {};  // "date|game" -> {sp,rn,act,gross,eng,mSp,mRn,aSp,aRn}
  const c = (d, g) => (by[`${d}|${g}`] = by[`${d}|${g}`] || { sp: 0, rn: 0, act: 0, gross: 0, eng: 0, mSp: 0, mRn: 0, aSp: 0, aRn: 0, game: g, date: d });
  ad.forEach(r => {
    const g = r[0], d = r[2]; if (!g || !d) return;
    const e = pnum(r[3]), gross = pnum(r[28]), i = pnum(r[7]);
    const x = c(d, g); x.sp += e; x.rn += e * ppct(r[4]); x.act += pnum(r[5]); x.gross += gross;
    if (i > 0) x.eng += gross / i;
    if (r[44] === '手动出价') { x.mSp += e; x.mRn += e * ppct(r[4]); }
    else if (r[44] === '自动出价') { x.aSp += e; x.aRn += e * ppct(r[4]); }
  });
  // 产品累计:每游戏按日期升序累计 消耗(投放) + 广告总收入(产品表) → serial|game
  const gameCum = {};
  {
    const serials = new Set();
    const games = new Set();
    Object.values(by).forEach(x => { const s = serAny(x.date); if (s) { serials.add(s); games.add(x.game); } });
    Object.keys(revMap).forEach(k => { serials.add(+k.split('|')[0]); games.add(k.split('|').slice(1).join('|')); });
    const ordered = [...serials].sort((a, b) => a - b);
    const spBySer = {};  // serial|game → 当日消耗
    Object.values(by).forEach(x => { const s = serAny(x.date); if (s) spBySer[`${s}|${x.game}`] = x.sp; });
    for (const g of games) {
      let cs = 0, cr = 0;
      for (const s of ordered) {
        cs += spBySer[`${s}|${g}`] || 0; cr += revMap[`${s}|${g}`] || 0;
        gameCum[`${s}|${g}`] = { cs, cr };
      }
    }
  }
  const rows = Object.values(by).filter(x => x.sp > 0)
    .sort((a, b) => (dateToSerial(b.date) - dateToSerial(a.date)) || (b.sp - a.sp));

  const r1 = v => Math.round(v * 10) / 10;
  const cellOf = (name, row, seq) => {
    const s = serAny(row.date);
    const cum = gameCum[`${s}|${row.game}`];
    switch (name) {
      case '序号': return seq;
      case '按天': return dateToSerial(row.date);
      case '项目组': return fullMap[row.game] || '';
      case '游戏名称': return row.game;
      case '消耗': return r1(row.sp);
      case '广告收入 ROAS (TikTok)': return row.sp ? row.rn / row.sp : '';
      case '活跃度平均成本': return row.act ? r1(row.sp / row.act) : '';
      case '活跃度': return Math.round(row.act);
      case '人均广告次数': return row.eng ? r1(row.gross / row.eng) : '';
      case '广告总收入': return r1(revMap[`${s}|${row.game}`] || 0);
      case '产品累计消耗': return cum ? r1(cum.cs) : '';
      case '产品累计收入': return cum ? r1(cum.cr) : '';
      case '产品累计ROI': return cum && cum.cs ? cum.cr / cum.cs : '';
      case '信号': {  // 回本信号:只判有规模的(累计消耗≥50),小额不报噪音
        if (!cum || cum.cs < 50) return '';
        const roi = cum.cr / cum.cs;
        return roi >= 1 ? '🟢已回本' : roi >= 0.7 ? '🟡接近回本' : '🔴回收偏低';
      }
      case '手动出价消耗': return row.mSp ? r1(row.mSp) : '';
      case '手动出价ROI': return row.mSp ? row.mRn / row.mSp : '';
      case '自动出价消耗': return row.aSp ? r1(row.aSp) : '';
      case '自动出价ROI': return row.aSp ? row.aRn / row.aSp : '';
      default: return '';
    }
  };
  const grid = rows.map((row, i) => header.map(name => (name ? cellOf(name, row, i + 1) : '')));
  const clearRows = rows.length + 1 + ROW_BUFFER;
  console.log(`  投放日表-产品维度(静态值): ${rows.length} 行(消耗>0)`);
  await writeStaticGrid(token, AD_PRODUCT_SHEET_ID, header, grid, clearRows);
  await clearTrailingCols(token, AD_PRODUCT_SHEET_ID, header.length + 1, clearRows);
  await applyColumnFormats(token, AD_PRODUCT_SHEET_ID, header, rows.length + 1);
  return rows.length + 1;
}

// Write a {col: gen(r)} plan over rows 2..targetRow in batches.
async function writeCols(token, sheetId, plan, targetRow) {
  for (const [col, gen] of Object.entries(plan)) {
    const values = [];
    for (let r = 2; r <= targetRow; r++) values.push([{ type: 'formula', text: gen(r) }]);
    const BATCH = 300;
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

// ─── 投放日表-素材维度 (TOBfe9) ─────────────────────────────────────────────
// One row per (day × 创意素材), deduped from ad-level 投放数据原表 and sorted by
// DATEVALUE(date)*1e7 + material-day 消耗 descending. 消耗=0 excluded. 项目组 is
// derived material→game (the ad row's 游戏名称) → group (product + extra map).

const AD_MATERIAL_SHEET_ID = 'TOBfe9';

async function getAdMaterialInfo(token) {
  const spend = {};
  let rowCount = 0, startRow = 2;
  while (true) {
    const r = await feishuReq('GET',
      `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values/uqJEhq!D${startRow}:M${startRow + 499}`, token);
    const rows = r.data?.valueRange?.values || [];
    if (!rows.length) break;
    let has = false;
    for (const row of rows) {
      const d = row[0], e = parseFloat(row[1]) || 0, mat = row[9]; // D=0 E=1 ... M=9
      if (mat && d) { has = true; rowCount++; const k = `${d}|${mat}`; spend[k] = (spend[k] || 0) + e; }
    }
    if (!has || rows.length < 500) break;
    startRow += 500;
  }
  return { adRowCount: rowCount, posCount: Object.values(spend).filter(v => v > 0).length };
}

// node 算静态值:按(日期×创意素材)聚合,消耗>0,日期降序+消耗降序。组=素材所属
// 游戏→组。展示量/点击率/CPM 从投放原表聚合。无公式。
async function ensureAdMaterialSummary(token) {
  let header = await readHeader(token, AD_MATERIAL_SHEET_ID);
  {
    const WANT_BID = ['手动出价消耗', '手动出价ROI', '自动出价消耗', '自动出价ROI'];
    const missing = WANT_BID.filter(n => !header.includes(n));
    if (missing.length) {
      header = [...header.filter(Boolean), ...missing];
      await feishuReq('PUT', `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values`, token,
        { valueRange: { range: `${AD_MATERIAL_SHEET_ID}!A1:${colLetter(header.length)}1`, values: [header] } });
    }
  }
  const { gameToGroup } = await getGroupMapping(token);
  const fullMap = { ...gameToGroup, ...EXTRA_GROUP_MAP };
  const ad = await readColsAll(token, 'uqJEhq', 'B', 'AT');  // B游戏0 D日期2 E消耗3 F4 G活跃度5 I7 M素材11 X点击22 Y展示23 AD_gross28 AT出价44
  const by = {};  // "date|material" -> {...}
  const c = (d, m, g) => { const k = `${d}|${m}`; const x = by[k] = by[k] || { sp: 0, rn: 0, act: 0, imp: 0, clk: 0, gross: 0, eng: 0, mSp: 0, mRn: 0, aSp: 0, aRn: 0, mat: m, date: d, game: '' }; if (g && !x.game) x.game = g; return x; };
  ad.forEach(r => {
    const g = r[0], d = r[2], m = r[11]; if (!m || !d) return;
    const e = pnum(r[3]), gross = pnum(r[28]), i = pnum(r[7]);
    const x = c(d, m, g); x.sp += e; x.rn += e * ppct(r[4]); x.act += pnum(r[5]); x.imp += pnum(r[23]); x.clk += pnum(r[22]); x.gross += gross;
    if (i > 0) x.eng += gross / i;
    if (r[44] === '手动出价') { x.mSp += e; x.mRn += e * ppct(r[4]); }
    else if (r[44] === '自动出价') { x.aSp += e; x.aRn += e * ppct(r[4]); }
  });
  const rows = Object.values(by).filter(x => x.sp > 0)
    .sort((a, b) => (dateToSerial(b.date) - dateToSerial(a.date)) || (b.sp - a.sp));

  const r1 = v => Math.round(v * 10) / 10;
  const cellOf = (name, row, seq) => {
    switch (name) {
      case '序号': return seq;
      case '按天': return dateToSerial(row.date);
      case '项目组': return fullMap[row.game] || '';
      case '创意素材名称': return row.mat;
      case '消耗': return r1(row.sp);
      case '广告收入 ROAS (TikTok)': return row.sp ? row.rn / row.sp : '';
      case '活跃度平均成本': return row.act ? r1(row.sp / row.act) : '';
      case '展示量': return Math.round(row.imp);
      case '点击率（目标页面）': return row.imp ? row.clk / row.imp : '';
      case '千次展示成本 (CPM)': return row.imp ? r1(row.sp / row.imp * 1000) : '';
      case '人均广告次数': return row.eng ? r1(row.gross / row.eng) : '';
      case '手动出价消耗': return row.mSp ? r1(row.mSp) : '';
      case '手动出价ROI': return row.mSp ? row.mRn / row.mSp : '';
      case '自动出价消耗': return row.aSp ? r1(row.aSp) : '';
      case '自动出价ROI': return row.aSp ? row.aRn / row.aSp : '';
      default: return '';
    }
  };
  const grid = rows.map((row, i) => header.map(name => (name ? cellOf(name, row, i + 1) : '')));
  const clearRows = rows.length + 1 + ROW_BUFFER;
  console.log(`  投放日表-素材维度(静态值): ${rows.length} 行(消耗>0)`);
  await writeStaticGrid(token, AD_MATERIAL_SHEET_ID, header, grid, clearRows);
  await clearTrailingCols(token, AD_MATERIAL_SHEET_ID, header.length + 1, clearRows);
  await applyColumnFormats(token, AD_MATERIAL_SHEET_ID, header, rows.length + 1);
  return rows.length + 1;
}

// ─── 投放日表-出价维度 (2zDzau) ─────────────────────────────────────────────
// One row per (day × game × 出价方式), deduped from ad-level 投放数据原表, sorted
// by DATEVALUE(date)*1e7 + (game,bid)-day 消耗 desc. 消耗=0 excluded. 项目组 via
// game→group (product + extra map).

const AD_BID_SHEET_ID = '2zDzau';

async function getAdBidInfo(token) {
  const spend = {};
  let rowCount = 0, startRow = 2;
  while (true) {
    const r = await feishuReq('GET',
      `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values/uqJEhq!B${startRow}:AT${startRow + 499}`, token);
    const rows = r.data?.valueRange?.values || [];
    if (!rows.length) break;
    let has = false;
    for (const row of rows) {
      const g = row[0], d = row[2], e = parseFloat(row[3]) || 0, bid = row[44]; // B=0 D=2 E=3 AT=45→idx44
      if (g && d && bid) { has = true; rowCount++; const k = `${d}|${g}|${bid}`; spend[k] = (spend[k] || 0) + e; }
    }
    if (!has || rows.length < 500) break;
    startRow += 500;
  }
  return { adRowCount: rowCount, posCount: Object.values(spend).filter(v => v > 0).length };
}

// node 算静态值:按(日期×游戏×出价方式)聚合,消耗>0。排序=日期降序 → 游戏聚类
// (按游戏总消耗) → 同游戏内出价按消耗降序。无公式。
async function ensureAdBidSummary(token) {
  const header = await readHeader(token, AD_BID_SHEET_ID);
  const { gameToGroup } = await getGroupMapping(token);
  const fullMap = { ...gameToGroup, ...EXTRA_GROUP_MAP };
  const ad = await readColsAll(token, 'uqJEhq', 'B', 'AT');  // B游戏0 D日期2 E消耗3 F4 G活跃度5 I人均次数7 AD_gross28 AT出价44
  const by = {}, gameTot = {};  // by: date|game|bid ; gameTot: date|game → 总消耗
  const c = (d, g, b) => (by[`${d}|${g}|${b}`] = by[`${d}|${g}|${b}`] || { sp: 0, rn: 0, act: 0, gross: 0, eng: 0, game: g, date: d, bid: b });
  ad.forEach(r => {
    const g = r[0], d = r[2], b = r[44]; if (!g || !d || !b) return;
    const e = pnum(r[3]), gross = pnum(r[28]), i = pnum(r[7]);
    const x = c(d, g, b); x.sp += e; x.rn += e * ppct(r[4]); x.act += pnum(r[5]); x.gross += gross;
    if (i > 0) x.eng += gross / i;
    gameTot[`${d}|${g}`] = (gameTot[`${d}|${g}`] || 0) + e;
  });
  const rows = Object.values(by).filter(x => x.sp > 0).sort((a, b) =>
    (dateToSerial(b.date) - dateToSerial(a.date)) ||
    (gameTot[`${b.date}|${b.game}`] - gameTot[`${a.date}|${a.game}`]) ||   // 游戏聚类
    (b.sp - a.sp));                                                       // 同游戏内消耗降序

  const r1 = v => Math.round(v * 10) / 10;
  const cellOf = (name, row, seq) => {
    switch (name) {
      case '序号': return seq;
      case '按天': return dateToSerial(row.date);
      case '项目组': return fullMap[row.game] || '';
      case '游戏名称': return row.game;
      case '出价方式': return row.bid;
      case '消耗': return r1(row.sp);
      case '广告收入 ROAS (TikTok)': return row.sp ? row.rn / row.sp : '';
      case '活跃度平均成本': return row.act ? r1(row.sp / row.act) : '';
      case '活跃度': return Math.round(row.act);
      case '人均广告次数': return row.eng ? r1(row.gross / row.eng) : '';
      default: return '';
    }
  };
  const grid = rows.map((row, i) => header.map(name => (name ? cellOf(name, row, i + 1) : '')));
  const clearRows = rows.length + 1 + ROW_BUFFER;
  console.log(`  投放日表-出价维度(静态值): ${rows.length} 行(消耗>0)`);
  await writeStaticGrid(token, AD_BID_SHEET_ID, header, grid, clearRows);
  await clearTrailingCols(token, AD_BID_SHEET_ID, header.length + 1, clearRows);
  await applyColumnFormats(token, AD_BID_SHEET_ID, header, rows.length + 1);
  return rows.length + 1;
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
  if (which === 'all' || which === 'adproduct') {
    console.log('Building 投放日表-产品维度...');
    const t = await ensureAdProductSummary(token);
    console.log(`  done, row ${t}.`);
  }
  if (which === 'all' || which === 'admaterial') {
    console.log('Building 投放日表-素材维度...');
    const t = await ensureAdMaterialSummary(token);
    console.log(`  done, row ${t}.`);
  }
  if (which === 'all' || which === 'adbid') {
    console.log('Building 投放日表-出价维度...');
    const t = await ensureAdBidSummary(token);
    console.log(`  done, row ${t}.`);
  }
}

if (require.main === module) {
  main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
}

module.exports = {
  ensureDailySummary, ensureProjectSummary, ensureAdProductSummary, ensureAdMaterialSummary,
  ensureAdBidSummary,
  getFeishuToken, getGroupMapping, getProductDateInfo, EXTRA_GROUP_MAP, applyColumnFormats, wrapDecimals, ensureGrid,
  readColsAll, writeStaticGrid, clearTrailingCols, dateToSerial, pnum, ppct,
};
