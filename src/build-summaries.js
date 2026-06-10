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

function feishuReq(method, path, token, body) {
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
  const AE = `${ADS}!$E$2:$E$5000`, AD = `${ADS}!$D$2:$D$5000`;
  const dtxt = r => `TEXT($${dCol}${r},"yyyy-MM-dd")`;   // this row's date as text (产品/投放 D are text)
  const guard = (r, body) => `=IF($${dCol}${r}="","",${body})`;

  const FIELD = {
    // reverse date sequence from inlined max serial; blank past the earliest day
    '统计周期': r => `=IF((${maxSerial}-ROW()+2)<${minSerial},"",${maxSerial}-ROW()+2)`,
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
function classify(name) {
  const n = (name || '').trim();
  if (FMT_DATE_NAMES.has(n)) return 'date';
  if (/ROAS|ROI|率/.test(n) || FMT_PCT_NAMES.has(n)) return 'pct';
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
    const style = type === 'date' ? { formatter: 'yyyy/MM/dd' }
      : type === 'pct' ? { formatter: '0.00%' }
      : type === 'int' ? { formatter: '#,##0' }
      : { formatter: '' };  // dec → general format, shows ROUND-ed 1-decimal value
    const r = await feishuReq('PUT', `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/style`, token,
      { appendStyle: { range: `${sheetId}!${col}2:${col}${targetRow}`, style } });
    if (r.code !== 0) console.warn(`  [warn] fmt ${col}(${name}):`, JSON.stringify(r).slice(0, 100));
  }
}

async function ensureDailySummary(token) {
  const header = await readHeader(token, SUMMARY_SHEET_ID);
  const { dayCount, maxSerial, minSerial } = await getProductDateInfo(token);
  const { plan, dateCol, roasCols } = buildPlan(header, maxSerial, minSerial);
  const targetRow = dayCount + 1 + ROW_BUFFER;
  console.log(`  日经营数据汇总: ${dayCount} 天 (serial ${minSerial}..${maxSerial}), 填充 2..${targetRow}`);
  wrapDecimals(plan, header);
  await writeFormulas(token, SUMMARY_SHEET_ID, targetRow, plan);
  await applyColumnFormats(token, SUMMARY_SHEET_ID, header, targetRow);
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
  // game → group from product table (product groups only)
  const gameToGroup = {};
  for (const grp of groups) for (const g of groupGames[grp]) gameToGroup[g] = grp;
  return { groups, groupGames, gameToGroup };
}

async function ensureProjectSummary(token) {
  const header = await readHeader(token, PROJECT_SHEET_ID);
  const L = {};
  header.forEach((name, j) => { if (name && !L[name]) L[name] = colLetter(j + 1); });
  // accept any of the candidate header names (the sheet's labels have been edited)
  const need = (...names) => {
    for (const n of names) if (L[n]) return L[n];
    throw new Error(`项目维度经营表缺少表头: ${names.join(' / ')}`);
  };
  const aCol = need('项目组'), bCol = need('统计周期'), cCol = need('消耗'), dCol = need('广告总收入'),
        eCol = need('当日广告收入 ROAS (TikTok)'), fCol = need('项目累计消耗', '累计消耗'),
        gCol = need('项目累计收入', '累计收入'), hCol = need('项目累计ROI', 'TT累计ROI'), iCol = need('新增用户');

  const { dayCount, maxSerial, minSerial } = await getProductDateInfo(token);
  const { groups, groupGames } = await getGroupMapping(token);
  const N = groups.length;
  if (N === 0) throw new Error('无项目组');
  const targetRow = dayCount * N + 1 + ROW_BUFFER;
  console.log(`  项目维度经营表: ${dayCount} 天 × ${N} 组, 填充 2..${targetRow}`);

  // helper columns: today spend (N), cumulative spend (N), sort key (N), pos (1)
  const TODAY0 = 18;                       // R
  const CUM0 = TODAY0 + N;
  const KEY0 = CUM0 + N;
  const POScol = colLetter(KEY0 + N);
  const todayCols = Array.from({ length: N }, (_, k) => colLetter(TODAY0 + k));
  const cumCols = Array.from({ length: N }, (_, k) => colLetter(CUM0 + k));
  const keyCols = Array.from({ length: N }, (_, k) => colLetter(KEY0 + k));

  const PD = `${PROD}!$D$2:$D$5000`, PAB = `${PROD}!$AB$2:$AB$5000`, PE = `${PROD}!$E$2:$E$5000`, PB = `${PROD}!$B$2:$B$5000`;
  const AE = `${ADS}!$E$2:$E$5000`, AD = `${ADS}!$D$2:$D$5000`, AB = `${ADS}!$B$2:$B$5000`;
  const gamesArr = groups.map(g => `{${groupGames[g].map(x => `"${x.replace(/"/g, '""')}"`).join(',')}}`);
  const groupsArr = `{${groups.map(g => `"${g}"`).join(',')}}`;

  // inline max/min serial as numeric constants (no helper cells → no ref drift)
  const dser = r => `(${maxSerial}-INT((${r}-2)/${N}))`;     // this row's date serial
  const invalid = r => `${dser(r)}<${minSerial}`;
  const dtxt = r => `TEXT(${dser(r)},"yyyy-MM-dd")`;
  const rank = r => `(MOD(${r}-2,${N})+1)`;
  const todayRange = r => `$${todayCols[0]}${r}:$${todayCols[N - 1]}${r}`;
  const cumRange = r => `$${cumCols[0]}${r}:$${cumCols[N - 1]}${r}`;
  const keyRange = r => `$${keyCols[0]}${r}:$${keyCols[N - 1]}${r}`;
  const pos = r => `$${POScol}${r}`;
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
  // helper: sort key = today spend * 1e5 + (N-1-k) tiebreak, so equal spends
  // (e.g. multiple 0s) still produce N distinct keys → no group dropped.
  keyCols.forEach((col, k) => {
    plan[col] = r => `=IF(${invalid(r)},"",$${todayCols[k]}${r}*100000+${N - 1 - k})`;
  });
  // helper: position of the rank-th highest key within this row's N groups
  plan[POScol] = r => `=IF(${invalid(r)},"",MATCH(LARGE(${keyRange(r)},${rank(r)}),${keyRange(r)},0))`;

  // visible columns by header name (use POS to pick the group/spend/cum)
  plan[bCol] = r => `=IF(${invalid(r)},"",${dser(r)})`;                                   // 统计周期
  plan[aCol] = r => `=IF(${pos(r)}="","",INDEX(${groupsArr},${pos(r)}))`;                 // 项目组
  plan[cCol] = r => `=IF(${pos(r)}="","",INDEX(${todayRange(r)},${pos(r)}))`;             // 消耗 (real value)
  plan[dCol] = r => ifGrp(r, `SUMIFS(${PAB},${PB},$${aCol}${r},${PD},${dtxt(r)})`);       // 广告总收入
  plan[eCol] = r => ifGrp(r, `IFERROR($${dCol}${r}/$${cCol}${r},"")`);                    // 当日 ROAS
  plan[fCol] = r => ifGrp(r, `INDEX(${cumRange(r)},${pos(r)})`);                          // 累计消耗
  plan[gCol] = r => ifGrp(r, `SUMPRODUCT((${PB}=$${aCol}${r})*(DATEVALUE(${PD})<=${dser(r)})*${PAB})`); // 累计收入
  plan[hCol] = r => ifGrp(r, `IFERROR($${gCol}${r}/$${fCol}${r},"")`);                    // 累计 ROI
  plan[iCol] = r => ifGrp(r, `SUMIFS(${PE},${PB},$${aCol}${r},${PD},${dtxt(r)})`);        // 新增用户

  wrapDecimals(plan, header);
  await writeFormulas(token, PROJECT_SHEET_ID, targetRow, plan);
  await applyColumnFormats(token, PROJECT_SHEET_ID, header, targetRow);
  // hide helper columns (today/cum/key spend + pos)
  await feishuReq('PUT', `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/dimension_range`, token,
    { dimension: { sheetId: PROJECT_SHEET_ID, majorDimension: 'COLUMNS', startIndex: TODAY0 - 1, endIndex: KEY0 + N },
      dimensionProperties: { visible: false } }).catch(() => {});
  return targetRow;
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

async function ensureAdProductSummary(token) {
  const header = await readHeader(token, AD_PRODUCT_SHEET_ID);
  const L = {};
  header.forEach((name, j) => { if (name && !L[name]) L[name] = colLetter(j + 1); });
  const need = n => { if (!L[n]) throw new Error(`投放日表-产品维度缺少表头: ${n}`); return L[n]; };
  const seqCol = need('序号'), dateCol = need('按天'), grpCol = need('项目组'), gameCol = need('游戏名称'),
        spendCol = need('消耗'), roasCol = need('广告收入 ROAS (TikTok)'), acostCol = need('活跃度平均成本'),
        actCol = need('活跃度'), apcCol = need('人均广告次数');

  const { adRowCount, posCount } = await getAdProductInfo(token);
  const { gameToGroup } = await getGroupMapping(token);
  const fullMap = { ...gameToGroup, ...EXTRA_GROUP_MAP };  // product groups + manual extras
  const mapGames = Object.keys(fullMap);
  const gamesArr = `{${mapGames.map(x => `"${x.replace(/"/g, '""')}"`).join(',')}}`;
  const groupsArr = `{${mapGames.map(x => `"${fullMap[x]}"`).join(',')}}`;
  const helperRows = adRowCount + 1 + 500;     // covers ad rows + growth
  const mainRows = posCount + 1 + 150;          // visible rows + buffer
  console.log(`  投放日表-产品维度: ${posCount} 组(消耗>0), helper→${helperRows}, main→${mainRows}`);

  // 投放数据原表 ranges
  const AB = `${ADS}!$B$2:$B$5000`, AD = `${ADS}!$D$2:$D$5000`, AE = `${ADS}!$E$2:$E$5000`,
        AF = `${ADS}!$F$2:$F$5000`, AG = `${ADS}!$G$2:$G$5000`, AAD = `${ADS}!$AD$2:$AD$5000`;
  // hidden helper columns: T isFirst, U gameDaySpend, V key, W matchedRow
  const T = 'T', U = 'U', V = 'V', W = 'W';

  // helper formulas over ad rows (row i ↔ 投放 row i)
  const helperPlan = {
    [T]: i => `=IF(${ADS}!$B${i}="","",IF(COUNTIFS(${ADS}!$B$2:$B${i},${ADS}!$B${i},${ADS}!$D$2:$D${i},${ADS}!$D${i})=1,1,0))`,
    [U]: i => `=IF(${ADS}!$B${i}="","",SUMIFS(${AE},${AB},${ADS}!$B${i},${AD},${ADS}!$D${i}))`,
    [V]: i => `=IF(AND($${T}${i}=1,$${U}${i}>0),DATEVALUE(${ADS}!$D${i})*10000000+$${U}${i},"")`,
  };
  // main formulas (row r): W=matched ad row via LARGE on key column
  const VR = `$${V}$2:$${V}$5000`, UR = `$${U}$2:$${U}$5000`;
  const g = r => `$${gameCol}${r}`, dt = r => `$${dateCol}${r}`;
  const ifg = (r, body) => `=IF(${g(r)}="","",${body})`;
  const mainPlan = {
    [W]: r => `=IFERROR(MATCH(LARGE(${VR},ROW()-1),${VR},0),"")`,
    [gameCol]: r => `=IF($${W}${r}="","",INDEX(${AB},$${W}${r}))`,
    [dateCol]: r => `=IF($${W}${r}="","",INDEX(${AD},$${W}${r}))`,
    [spendCol]: r => `=IF($${W}${r}="","",INDEX(${UR},$${W}${r}))`,
    [seqCol]: r => `=IF(${g(r)}="","",ROW()-1)`,
    [grpCol]: r => ifg(r, `IFERROR(INDEX(${groupsArr},MATCH(${g(r)},${gamesArr},0)),"")`),
    [actCol]: r => ifg(r, `SUMIFS(${AG},${AB},${g(r)},${AD},${dt(r)})`),
    [acostCol]: r => ifg(r, `IFERROR($${spendCol}${r}/$${actCol}${r},"")`),
    [roasCol]: r => ifg(r, `IFERROR(SUMPRODUCT((${AB}=${g(r)})*(${AD}=${dt(r)})*${AF}*${AE})/$${spendCol}${r},"")`),
    // 人均广告次数 = Σgross / Σengaged; engaged reconstructed as gross/投放!I per row
    [apcCol]: r => ifg(r, `IFERROR(SUMIFS(${AAD},${AB},${g(r)},${AD},${dt(r)})/SUMPRODUCT((${AB}=${g(r)})*(${AD}=${dt(r)})*(N(${ADS}!$I$2:$I$5000)>0)*${AAD}/(N(${ADS}!$I$2:$I$5000)+(N(${ADS}!$I$2:$I$5000)=0))),"")`),
  };

  // write helper columns (rows 2..helperRows)
  await writeCols(token, AD_PRODUCT_SHEET_ID, helperPlan, helperRows);
  // write main columns (rows 2..mainRows)
  wrapDecimals(mainPlan, header);
  await writeCols(token, AD_PRODUCT_SHEET_ID, mainPlan, mainRows);
  // formats: date col, ROAS percent
  await applyColumnFormats(token, AD_PRODUCT_SHEET_ID, header, mainRows);
  // hide helper columns T..W (index 19..22)
  await feishuReq('PUT', `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/dimension_range`, token,
    { dimension: { sheetId: AD_PRODUCT_SHEET_ID, majorDimension: 'COLUMNS', startIndex: 19, endIndex: 23 },
      dimensionProperties: { visible: false } }).catch(() => {});
  return mainRows;
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

async function ensureAdMaterialSummary(token) {
  const header = await readHeader(token, AD_MATERIAL_SHEET_ID);
  const L = {};
  header.forEach((name, j) => { if (name && !L[name]) L[name] = colLetter(j + 1); });
  const need = (...names) => { for (const n of names) if (L[n]) return L[n]; throw new Error(`投放日表-素材维度缺少表头: ${names.join('/')}`); };
  const seqCol = need('序号'), dateCol = need('按天'), grpCol = need('项目组'), matCol = need('创意素材名称'),
        spendCol = need('消耗'), roasCol = need('广告收入 ROAS (TikTok)'), acostCol = need('活跃度平均成本'),
        impCol = need('展示量'), ctrCol = need('点击率（目标页面）'), cpmCol = need('千次展示成本 (CPM)'),
        apcCol = need('人均广告次数');

  const { adRowCount, posCount } = await getAdMaterialInfo(token);
  const { gameToGroup } = await getGroupMapping(token);
  const fullMap = { ...gameToGroup, ...EXTRA_GROUP_MAP };
  const mapGames = Object.keys(fullMap);
  const gamesArr = `{${mapGames.map(x => `"${x.replace(/"/g, '""')}"`).join(',')}}`;
  const groupsArr = `{${mapGames.map(x => `"${fullMap[x]}"`).join(',')}}`;
  const helperRows = adRowCount + 1 + 500;
  const mainRows = posCount + 1 + 300;
  console.log(`  投放日表-素材维度: ${posCount} 组(消耗>0), helper→${helperRows}, main→${mainRows}`);

  const AM = `${ADS}!$M$2:$M$5000`, AD = `${ADS}!$D$2:$D$5000`, AE = `${ADS}!$E$2:$E$5000`,
        AF = `${ADS}!$F$2:$F$5000`, AG = `${ADS}!$G$2:$G$5000`, AB = `${ADS}!$B$2:$B$5000`,
        AX = `${ADS}!$X$2:$X$5000`, AY = `${ADS}!$Y$2:$Y$5000`, AAD = `${ADS}!$AD$2:$AD$5000`;
  const T = 'T', U = 'U', V = 'V', W = 'W';
  const helperPlan = {
    [T]: i => `=IF(${ADS}!$M${i}="","",IF(COUNTIFS(${ADS}!$M$2:$M${i},${ADS}!$M${i},${ADS}!$D$2:$D${i},${ADS}!$D${i})=1,1,0))`,
    [U]: i => `=IF(${ADS}!$M${i}="","",SUMIFS(${AE},${AM},${ADS}!$M${i},${AD},${ADS}!$D${i}))`,
    [V]: i => `=IF(AND($${T}${i}=1,$${U}${i}>0),DATEVALUE(${ADS}!$D${i})*10000000+$${U}${i},"")`,
  };
  const VR = `$${V}$2:$${V}$5000`, UR = `$${U}$2:$${U}$5000`;
  const m = r => `$${matCol}${r}`, dt = r => `$${dateCol}${r}`;
  const ifm = (r, body) => `=IF(${m(r)}="","",${body})`;
  const sif = (range, r) => `SUMIFS(${range},${AM},${m(r)},${AD},${dt(r)})`;
  const mainPlan = {
    [W]: r => `=IFERROR(MATCH(LARGE(${VR},ROW()-1),${VR},0),"")`,
    [matCol]: r => `=IF($${W}${r}="","",INDEX(${AM},$${W}${r}))`,
    [dateCol]: r => `=IF($${W}${r}="","",INDEX(${AD},$${W}${r}))`,
    [spendCol]: r => `=IF($${W}${r}="","",INDEX(${UR},$${W}${r}))`,
    [seqCol]: r => `=IF(${m(r)}="","",ROW()-1)`,
    // material → game (the matched ad row's 游戏) → group
    [grpCol]: r => `=IF($${W}${r}="","",IFERROR(INDEX(${groupsArr},MATCH(INDEX(${AB},$${W}${r}),${gamesArr},0)),""))`,
    [impCol]: r => ifm(r, sif(AY, r)),
    [acostCol]: r => ifm(r, `IFERROR($${spendCol}${r}/${sif(AG, r)},"")`),
    [roasCol]: r => ifm(r, `IFERROR(SUMPRODUCT((${AM}=${m(r)})*(${AD}=${dt(r)})*${AF}*${AE})/$${spendCol}${r},"")`),
    [ctrCol]: r => ifm(r, `IFERROR(${sif(AX, r)}/$${impCol}${r},"")`),
    [cpmCol]: r => ifm(r, `IFERROR($${spendCol}${r}/$${impCol}${r}*1000,"")`),
    // 人均广告次数 = Σgross / Σengaged; engaged = gross/投放!I per row
    [apcCol]: r => ifm(r, `IFERROR(${sif(AAD, r)}/SUMPRODUCT((${AM}=${m(r)})*(${AD}=${dt(r)})*(N(${ADS}!$I$2:$I$5000)>0)*${AAD}/(N(${ADS}!$I$2:$I$5000)+(N(${ADS}!$I$2:$I$5000)=0))),"")`),
  };

  await writeCols(token, AD_MATERIAL_SHEET_ID, helperPlan, helperRows);
  wrapDecimals(mainPlan, header);
  await writeCols(token, AD_MATERIAL_SHEET_ID, mainPlan, mainRows);
  await applyColumnFormats(token, AD_MATERIAL_SHEET_ID, header, mainRows);
  await feishuReq('PUT', `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/dimension_range`, token,
    { dimension: { sheetId: AD_MATERIAL_SHEET_ID, majorDimension: 'COLUMNS', startIndex: 19, endIndex: 23 },
      dimensionProperties: { visible: false } }).catch(() => {});
  return mainRows;
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

async function ensureAdBidSummary(token) {
  const header = await readHeader(token, AD_BID_SHEET_ID);
  const L = {};
  header.forEach((name, j) => { if (name && !L[name]) L[name] = colLetter(j + 1); });
  const need = (...names) => { for (const n of names) if (L[n]) return L[n]; throw new Error(`投放日表-出价维度缺少表头: ${names.join('/')}`); };
  const seqCol = need('序号'), dateCol = need('按天'), grpCol = need('项目组'), gameCol = need('游戏名称'),
        bidCol = need('出价方式'), spendCol = need('消耗'), roasCol = need('广告收入 ROAS (TikTok)'),
        acostCol = need('活跃度平均成本'), actCol = need('活跃度'), apcCol = need('人均广告次数');

  const { adRowCount, posCount } = await getAdBidInfo(token);
  const { gameToGroup } = await getGroupMapping(token);
  const fullMap = { ...gameToGroup, ...EXTRA_GROUP_MAP };
  const mapGames = Object.keys(fullMap);
  const gamesArr = `{${mapGames.map(x => `"${x.replace(/"/g, '""')}"`).join(',')}}`;
  const groupsArr = `{${mapGames.map(x => `"${fullMap[x]}"`).join(',')}}`;
  const helperRows = adRowCount + 1 + 500;
  const mainRows = posCount + 1 + 200;
  console.log(`  投放日表-出价维度: ${posCount} 组(消耗>0), helper→${helperRows}, main→${mainRows}`);

  const AB = `${ADS}!$B$2:$B$5000`, AD = `${ADS}!$D$2:$D$5000`, AE = `${ADS}!$E$2:$E$5000`,
        AF = `${ADS}!$F$2:$F$5000`, AG = `${ADS}!$G$2:$G$5000`, AAD = `${ADS}!$AD$2:$AD$5000`,
        AAT = `${ADS}!$AT$2:$AT$5000`;
  const T = 'T', U = 'U', V = 'V', W = 'W', X = 'X';
  // Sort key clusters by game (game total spend, all bids), then by this row's
  // (game,bid) spend within the game: date*1e8 + ROUND(gameTotal)*1e4 + ROUND(bidSpend,1)*10.
  const helperPlan = {
    [T]: i => `=IF(${ADS}!$B${i}="","",IF(COUNTIFS(${ADS}!$B$2:$B${i},${ADS}!$B${i},${ADS}!$D$2:$D${i},${ADS}!$D${i},${ADS}!$AT$2:$AT${i},${ADS}!$AT${i})=1,1,0))`,
    [U]: i => `=IF(${ADS}!$B${i}="","",SUMIFS(${AE},${AB},${ADS}!$B${i},${AD},${ADS}!$D${i},${AAT},${ADS}!$AT${i}))`,
    [X]: i => `=IF(${ADS}!$B${i}="","",SUMIFS(${AE},${AB},${ADS}!$B${i},${AD},${ADS}!$D${i}))`,  // game total (all bids)
    [V]: i => `=IF(AND($${T}${i}=1,$${U}${i}>0),DATEVALUE(${ADS}!$D${i})*100000000+ROUND($${X}${i},0)*10000+ROUND($${U}${i},1)*10,"")`,
  };
  const VR = `$${V}$2:$${V}$5000`, UR = `$${U}$2:$${U}$5000`;
  const g = r => `$${gameCol}${r}`, dt = r => `$${dateCol}${r}`, bd = r => `$${bidCol}${r}`;
  const ifg = (r, body) => `=IF(${g(r)}="","",${body})`;
  // SUMIFS keyed on game + date + 出价方式
  const sif = (range, r) => `SUMIFS(${range},${AB},${g(r)},${AD},${dt(r)},${AAT},${bd(r)})`;
  const mainPlan = {
    [W]: r => `=IFERROR(MATCH(LARGE(${VR},ROW()-1),${VR},0),"")`,
    [gameCol]: r => `=IF($${W}${r}="","",INDEX(${AB},$${W}${r}))`,
    [dateCol]: r => `=IF($${W}${r}="","",INDEX(${AD},$${W}${r}))`,
    [bidCol]: r => `=IF($${W}${r}="","",INDEX(${AAT},$${W}${r}))`,
    [spendCol]: r => `=IF($${W}${r}="","",INDEX(${UR},$${W}${r}))`,
    [seqCol]: r => `=IF(${g(r)}="","",ROW()-1)`,
    [grpCol]: r => ifg(r, `IFERROR(INDEX(${groupsArr},MATCH(${g(r)},${gamesArr},0)),"")`),
    [actCol]: r => ifg(r, sif(AG, r)),
    [acostCol]: r => ifg(r, `IFERROR($${spendCol}${r}/${sif(AG, r)},"")`),
    [roasCol]: r => ifg(r, `IFERROR(SUMPRODUCT((${AB}=${g(r)})*(${AD}=${dt(r)})*(${AAT}=${bd(r)})*${AF}*${AE})/$${spendCol}${r},"")`),
    // 人均广告次数 = Σgross / Σengaged; engaged = gross/投放!I per row (game+date+bid)
    [apcCol]: r => ifg(r, `IFERROR(${sif(AAD, r)}/SUMPRODUCT((${AB}=${g(r)})*(${AD}=${dt(r)})*(${AAT}=${bd(r)})*(N(${ADS}!$I$2:$I$5000)>0)*${AAD}/(N(${ADS}!$I$2:$I$5000)+(N(${ADS}!$I$2:$I$5000)=0))),"")`),
  };

  wrapDecimals(mainPlan, header);
  await writeCols(token, AD_BID_SHEET_ID, helperPlan, helperRows);
  await writeCols(token, AD_BID_SHEET_ID, mainPlan, mainRows);
  await applyColumnFormats(token, AD_BID_SHEET_ID, header, mainRows);
  // hide helper cols T,U,V,W,X (indices 19..23)
  await feishuReq('PUT', `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/dimension_range`, token,
    { dimension: { sheetId: AD_BID_SHEET_ID, majorDimension: 'COLUMNS', startIndex: 19, endIndex: 24 },
      dimensionProperties: { visible: false } }).catch(() => {});
  return mainRows;
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
  getFeishuToken, getGroupMapping, getProductDateInfo, EXTRA_GROUP_MAP, applyColumnFormats, wrapDecimals,
};
