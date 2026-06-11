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
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || (() => { throw new Error('FEISHU_APP_SECRET env is required'); })();

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

// INDEX into 产品数据原表 column `col` at the reverse-mirrored source row $U{r}
function colLetter(n) { let c = ''; while (n > 0) { const r = (n - 1) % 26; c = String.fromCharCode(65 + r) + c; n = Math.floor((n - 1) / 26); } return c; }

// Report field -> data source, placed by HEADER NAME (reordering columns can't
// misalign). 'prod' pulls 产品数据原表 column `col` (via the matched product row);
// 'spend/roas/...' compute from 投放数据原表; date/game/group come from the grid.
const FIELD_SRC = {
  '序号': { kind: 'seq' },
  '统计周期': { kind: 'date' },
  '项目组': { kind: 'group' },
  '游戏名称': { kind: 'game' },
  '消耗': { kind: 'spend' },
  '广告收入 ROAS (TikTok)': { kind: 'roas' },
  '活跃度': { kind: 'activity' },
  '活跃度平均成本': { kind: 'activecost' },
  '人均广告次数': { kind: 'apc' },
  '点击率（目标页面）': { kind: 'ctr' },
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

async function readHeader(token, sheetId = REPORT_SHEET_ID) {
  const r = await feishuReq('GET',
    `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values/${sheetId}!A1:AZ1`, token);
  return (r.data?.valueRange?.values?.[0] || []).map(v => (v == null ? '' : String(v).trim()));
}

// Grid model: rows = (date × game), date descending over 产品∪投放 dates (so the
// latest 投放 day appears before 产品 data lands). Within a date the games are
// ordered by their 项目组's day spend (from 项目维度经营表) then the game's own
// 投放 spend. Helper cols (hidden): per-game sort keys, POS, PRODROW, SHOW.
const PROJ = "'项目维度经营表'";
function buildPlan(header, gameList, groupList, maxSerial, minSerial, projCols) {
  const nameToLetter = {};
  header.forEach((name, j) => { if (name && !nameToLetter[name]) nameToLetter[name] = colLetter(j + 1); });
  const gCol = nameToLetter['游戏名称'], dCol = nameToLetter['统计周期'], eCol = nameToLetter['消耗'],
        nCol = nameToLetter['新增用户'], sCol = nameToLetter['广告总收入'];
  for (const [n, v] of [['游戏名称', gCol], ['统计周期', dCol], ['消耗', eCol], ['新增用户', nCol], ['广告总收入', sCol]]) {
    if (!v) throw new Error(`日报表缺少必需表头列: ${n}`);
  }
  const G = gameList.length;
  const lastHdr = header.reduce((m, h, j) => (h ? j + 1 : m), 0);
  const HELP0 = lastHdr + 3;                          // helper cols start after the visible header (+2 gap)
  const keyCols = Array.from({ length: G }, (_, k) => colLetter(HELP0 + k));
  const POSc = colLetter(HELP0 + G), SHOWc = colLetter(HELP0 + G + 1);
  const gameArr = `{${gameList.map(x => `"${x.replace(/"/g, '""')}"`).join(',')}}`;
  const groupArr = `{${groupList.map(x => `"${x.replace(/"/g, '""')}"`).join(',')}}`;

  const dser = r => `(${maxSerial}-INT((${r}-2)/${G}))`;   // this row's date serial
  const invalid = r => `${dser(r)}<${minSerial}`;
  const dtxt = r => `TEXT(${dser(r)},"yyyy-MM-dd")`;
  const rank = r => `(MOD(${r}-2,${G})+1)`;
  const keyRange = r => `$${keyCols[0]}${r}:$${keyCols[G - 1]}${r}`;
  const pos = r => `$${POSc}${r}`;
  const sumifs = (col, r) => `SUMIFS(${ADS}!$${col}$2:$${col}$5000,${ADS}!$B$2:$B$5000,$${gCol}${r},${ADS}!$D$2:$D$5000,TEXT($${dCol}${r},"yyyy-MM-dd"))`;
  // product-side value for (game,date). Numeric cols → SUMIFS (unique row, so the
  // sum is the value; blank/0 before 产品 data lands). Text-% cols (启动成功率,
  // 广告点击率) can't be summed → INDEX the matched row via MATCH(1,(game)*(date)).
  const prodSum = col => r => `=IF($${gCol}${r}="","",SUMIFS(${PROD}!$${col}$2:$${col}$5000,${PROD}!$C$2:$C$5000,$${gCol}${r},${PROD}!$D$2:$D$5000,TEXT($${dCol}${r},"yyyy-MM-dd")))`;
  const prodIdx = col => r => `=IF($${gCol}${r}="","",IFERROR(LOOKUP(2,1/((${PROD}!$C$2:$C$5000=$${gCol}${r})*(${PROD}!$D$2:$D$5000=TEXT($${dCol}${r},"yyyy-MM-dd"))),${PROD}!$${col}$2:$${col}$5000),""))`;
  const TEXT_PROD_COLS = new Set(['P', 'Y']);   // 启动成功率, 广告点击率 (text "%")
  const prodAt = col => (TEXT_PROD_COLS.has(col) ? prodIdx(col) : prodSum(col));
  const gen = {
    seq: r => `=IF($${gCol}${r}="","",ROW()-1)`,
    date: r => `=IF(${invalid(r)},"",${dser(r)})`,
    game: r => `=IF(${pos(r)}="","",IFERROR(INDEX(${gameArr},${pos(r)}),""))`,
    group: r => `=IF(${pos(r)}="","",IFERROR(INDEX(${groupArr},${pos(r)}),""))`,
    spend: r => `=IF($${gCol}${r}="","",${sumifs('E', r)})`,
    roas: r => `=IF($${gCol}${r}="","",IFERROR(SUMPRODUCT((${ADS}!$B$2:$B$5000=$${gCol}${r})*(${ADS}!$D$2:$D$5000=TEXT($${dCol}${r},"yyyy-MM-dd"))*${ADS}!$F$2:$F$5000*${ADS}!$E$2:$E$5000)/$${eCol}${r},""))`,
    activecost: r => `=IF($${gCol}${r}="","",IFERROR($${eCol}${r}/${sumifs('G', r)},""))`,
    activity: r => `=IF($${gCol}${r}="","",${sumifs('G', r)})`,
    apc: r => `=IF($${gCol}${r}="","",IFERROR(SUMPRODUCT((${ADS}!$B$2:$B$5000=$${gCol}${r})*(${ADS}!$D$2:$D$5000=TEXT($${dCol}${r},"yyyy-MM-dd"))*IFERROR(VALUE(${ADS}!$G$2:$G$5000),0)*IFERROR(VALUE(${ADS}!$I$2:$I$5000),0))/${sumifs('G', r)},""))`,
    ctr: r => `=IF($${gCol}${r}="","",IFERROR(${sumifs('X', r)}/${sumifs('Y', r)},""))`,
    opcost: r => `=IF($${gCol}${r}="","",IFERROR($${eCol}${r}/$${nCol}${r},""))`,
  };
  const plan = {};
  header.forEach((name, j) => {
    const spec = FIELD_SRC[name];
    if (!spec) return;
    plan[colLetter(j + 1)] = spec.kind === 'prod' ? prodAt(spec.col) : gen[spec.kind];
  });
  // helper: per-fixed-game sort key = group-spend*1e6 + game-spend*1e3 + (G-k)
  // tiebreak. Group spend read from 项目维度经营表 by header-resolved columns
  // (the sheet may have a leading 序号 col, so don't hardcode A/B/C).
  const PG = projCols.grp, PD = projCols.date, PC = projCols.spend;
  keyCols.forEach((col, k) => {
    plan[col] = r => `=IF(${invalid(r)},"",N(SUMIFS(${PROJ}!$${PC}$2:$${PC}$5000,${PROJ}!$${PG}$2:$${PG}$5000,"${groupList[k]}",${PROJ}!$${PD}$2:$${PD}$5000,${dser(r)}))*1000000+N(SUMIFS(${ADS}!$E$2:$E$5000,${ADS}!$B$2:$B$5000,"${gameList[k].replace(/"/g, '""')}",${ADS}!$D$2:$D$5000,${dtxt(r)}))*1000+${G - k})`;
  });
  // helper POS: index of the rank-th highest key among this date's G games
  plan[POSc] = r => `=IF(${invalid(r)},"",MATCH(LARGE(${keyRange(r)},${rank(r)}),${keyRange(r)},0))`;
  // helper SHOW: 0 when 消耗 and 广告总收入 are both 0 → filtered out
  plan[SHOWc] = r => `=IF($${gCol}${r}="","",IF(AND(N($${eCol}${r})=0,N($${sCol}${r})=0),0,1))`;

  const intCols = ['新增用户', '活跃用户', '总用户数', '总启动次数'].map(n => nameToLetter[n]).filter(Boolean);
  // helper cols span 1-based [HELP0, HELP0+G+1]; dimension API is 0-based exclusive.
  return { plan, dateCol: dCol, roasCol: nameToLetter['广告收入 ROAS (TikTok)'], intCols,
           helpStart: HELP0 - 1, helpEnd: HELP0 + G + 1, showCol: SHOWc, G };
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

// Hide helper columns [helpStart, helpEnd) (0-based indices).
async function hideHelperCols(token, helpStart, helpEnd) {
  const r = await feishuReq('PUT',
    `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/dimension_range`, token,
    { dimension: { sheetId: REPORT_SHEET_ID, majorDimension: 'COLUMNS', startIndex: helpStart, endIndex: helpEnd },
      dimensionProperties: { visible: false } });
  if (r.code !== 0) console.warn('  [warn] hide helpers:', JSON.stringify(r).slice(0, 120));
}

// Show only rows where SHOW col > 0 (hide rows whose 消耗 AND 广告总收入 are both 0).
// A sheet holds at most one filter: PUT-update if it exists, else POST-create.
async function applyFilter(token, targetRow, showCol) {
  const cond = { filter_type: 'number', compare_type: 'greater', expected: ['0'] };
  const base = `/open-apis/sheets/v3/spreadsheets/${SPREADSHEET_TOKEN}/sheets/${REPORT_SHEET_ID}/filter`;
  const g = await feishuReq('GET', base, token).catch(() => ({}));
  const exists = g?.data?.sheet_filter_info?.filter_infos?.length > 0;
  let r;
  if (exists) {
    r = await feishuReq('PUT', base, token, { col: showCol, condition: cond });
  } else {
    r = await feishuReq('POST', base, token, { range: `${REPORT_SHEET_ID}!A1:${showCol}${targetRow}`, col: showCol, condition: cond });
  }
  if (r.code !== 0) console.warn('  [warn] set filter:', JSON.stringify(r).slice(0, 150));
}

// node 算静态值:行=(游戏×日期),保留消耗>0或收入>0的行。投放侧聚合投放原表,
// 产品侧取产品原表对应(游戏,日期)行。排序=日期降序 → 组消耗降序 → 组内游戏消耗
// 降序。无公式、无 filter、无 helper 列 → 源表变动不触发重算。
async function ensureReportFormulas(token) {
  const { applyColumnFormats, getGroupMapping, getProductDateInfo, readColsAll,
          writeStaticGrid, clearTrailingCols, dateToSerial, pnum, ppct } = require('./build-summaries');
  let header = await readHeader(token);
  {
    const WANT_BID = ['手动出价消耗', '手动出价ROI', '自动出价消耗', '自动出价ROI'];
    const clean = header.filter(h => h && !String(h).startsWith('_'));
    const missing = WANT_BID.filter(n => !clean.includes(n));
    if (missing.length) {
      header = [...clean, ...missing];
      const { feishuReq: fq } = module.exports._deps || {};
      await feishuReq('PUT', `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values`, token,
        { valueRange: { range: `${REPORT_SHEET_ID}!A1:${colLetter(header.length + 4)}1`, values: [[...header, '', '', '', '']] } });
    }
  }
  const { groups, groupGames, gameToGroup } = await getGroupMapping(token);
  const gameList = [];
  for (const grp of groups) for (const g of groupGames[grp]) gameList.push(g);

  const adRows   = await readColsAll(token, 'uqJEhq', 'B', 'AT');  // B游戏0 D日期2 E消耗3 F4 G活跃度5 I人均次数7 X点击22 Y展示23 AD_gross28 AT出价44
  const prodRows = await readColsAll(token, 'c50205', 'C', 'AB');  // C游戏0 D日期1 E新增2 F活跃3 K进入8 L时长9 N启速11 O首启12 P启成率13 Y点击率22 Z_eCPM23 AA人均展示24 AB收入25

  const ag = {}, byGroup = {};  // ag: game|date→{sp,rn,act}; byGroup: group|date→总消耗
  adRows.forEach(r => {
    const g = r[0], d = r[2]; if (!g || !d) return;
    const e = pnum(r[3]); const k = `${g}|${d}`;
    const x = ag[k] = ag[k] || { sp: 0, rn: 0, act: 0, gross: 0, eng: 0, clk: 0, imp: 0, mSp: 0, mRn: 0, aSp: 0, aRn: 0 };
    const gross = pnum(r[28]), i = pnum(r[7]);
    x.sp += e; x.rn += e * ppct(r[4]); x.act += pnum(r[5]);
    x.gross += gross; if (i > 0) x.eng += gross / i;
    x.clk += pnum(r[22]); x.imp += pnum(r[23]);
    if (r[44] === '手动出价') { x.mSp += e; x.mRn += e * ppct(r[4]); }
    else if (r[44] === '自动出价') { x.aSp += e; x.aRn += e * ppct(r[4]); }
    const grp = gameToGroup[g]; if (grp) byGroup[`${grp}|${d}`] = (byGroup[`${grp}|${d}`] || 0) + e;
  });
  const pm = {};  // game|date → 产品指标行
  prodRows.forEach(r => { if (r[0] && r[1]) pm[`${r[0]}|${r[1]}`] = r; });

  const { maxSerial, minSerial } = await getProductDateInfo(token);
  const dates = [];
  for (let s = maxSerial; s >= minSerial; s--) dates.push(new Date(Math.round((s - 25569) * 864e5)).toISOString().slice(0, 10));

  const r1 = v => Math.round(v * 10) / 10;
  const rowsRaw = [];
  for (const date of dates) for (const game of gameList) {
    const a = ag[`${game}|${date}`] || { sp: 0, rn: 0, act: 0, gross: 0, eng: 0, clk: 0, imp: 0, mSp: 0, mRn: 0, aSp: 0, aRn: 0 };
    const p = pm[`${game}|${date}`] || null;
    const rev = p ? pnum(p[25]) : 0;
    if (a.sp <= 0 && rev <= 0) continue;  // 双0行不写(等价于旧 filter 隐藏)
    rowsRaw.push({ game, date, grp: gameToGroup[game] || '', a, p, rev,
      gs: byGroup[`${(gameToGroup[game] || '')}|${date}`] || 0 });
  }
  rowsRaw.sort((x, y) =>
    (dateToSerial(y.date) - dateToSerial(x.date)) || (y.gs - x.gs) || (y.a.sp - x.a.sp));

  const cellOf = (name, row, seq) => {
    const { a, p, game, date, grp, rev } = row;
    const newU = p ? pnum(p[2]) : 0;
    switch (name) {
      case '序号': return seq;
      case '统计周期': return dateToSerial(date);
      case '项目组': return grp;
      case '游戏名称': return game;
      case '消耗': return r1(a.sp);
      case '广告收入 ROAS (TikTok)': return a.sp ? a.rn / a.sp : '';
      case '活跃度': return a.act || a.sp ? Math.round(a.act) : '';   // 投放侧广告新增(unique first launch)
      case '活跃度平均成本': return a.act ? r1(a.sp / a.act) : '';
      case '人均广告次数': return a.eng ? r1(a.gross / a.eng) : '';
      case '点击率（目标页面）': return a.imp ? a.clk / a.imp : '';
      case '运营新增成本': return newU ? r1(a.sp / newU) : '';
      case '新增用户': return p ? Math.round(newU) : '';
      case '活跃用户': return p ? Math.round(pnum(p[3])) : '';
      case '人均进入次数': return p ? r1(pnum(p[8])) : '';
      case '每位用户平均时长(分)': return p ? r1(pnum(p[9])) : '';
      case '平均启动速度(秒)': return p ? r1(pnum(p[11])) : '';
      case '平均首次启动速度(秒)': return p ? r1(pnum(p[12])) : '';
      case '启动成功率': return p ? ppct(p[13]) : '';
      case 'eCPM': return p ? r1(pnum(p[23])) : '';
      case '广告点击率': return p ? ppct(p[22]) : '';
      case '人均广告展示次数': return p ? r1(pnum(p[24])) : '';
      case '广告总收入': return r1(rev);
      case '手动出价消耗': return a.mSp ? r1(a.mSp) : '';
      case '手动出价ROI': return a.mSp ? a.mRn / a.mSp : '';
      case '自动出价消耗': return a.aSp ? r1(a.aSp) : '';
      case '自动出价ROI': return a.aSp ? a.aRn / a.aSp : '';
      default: return '';
    }
  };
  const grid = rowsRaw.map((row, i) => header.map(name => (name ? cellOf(name, row, i + 1) : '')));
  const clearRows = rowsRaw.length + 1 + ROW_BUFFER;
  console.log(`  产品经营日报表(静态值): ${gameList.length}游戏 × ${dates.length}天 → ${rowsRaw.length}行(消耗或收入>0)`);
  await writeStaticGrid(token, REPORT_SHEET_ID, header, grid, clearRows);
  await clearTrailingCols(token, REPORT_SHEET_ID, header.length + 1, clearRows);
  await applyColumnFormats(token, REPORT_SHEET_ID, header, rowsRaw.length + 1);
  return rowsRaw.length + 1;
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
