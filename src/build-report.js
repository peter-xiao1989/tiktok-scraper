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
function prodIdx(r, col) {
  return `=IFERROR(IF($U${r}<1,"",INDEX(${PROD}!$${col}$2:$${col}$5000,$U${r})),"")`;
}

// SUMIFS over 投放数据原表 column `col` for game $D{r} + date $B{r}
function adsSumifs(r, col) {
  return `SUMIFS(${ADS}!$${col}$2:$${col}$5000,${ADS}!$B$2:$B$5000,$D${r},${ADS}!$D$2:$D$5000,TEXT($B${r},"yyyy-MM-dd"))`;
}

// Column formula generators, keyed by report column letter
const COLS = {
  A: r => `=IF($D${r}="","",ROW()-1)`,                              // 序号
  B: r => prodIdx(r, 'D'),                                          // 统计周期
  C: r => prodIdx(r, 'B'),                                          // 项目组
  D: r => prodIdx(r, 'C'),                                          // 游戏名称
  E: r => `=IF($D${r}="","",${adsSumifs(r, 'E')})`,                 // 消耗
  F: r => `=IF($D${r}="","",IFERROR(SUMPRODUCT((${ADS}!$B$2:$B$5000=$D${r})*(${ADS}!$D$2:$D$5000=TEXT($B${r},"yyyy-MM-dd"))*${ADS}!$F$2:$F$5000*${ADS}!$E$2:$E$5000)/$E${r},""))`, // 广告收入 ROAS (加权)
  G: r => `=IF($D${r}="","",IFERROR($E${r}/${adsSumifs(r, 'G')},""))`, // 活跃度平均成本 = 消耗/活跃度
  H: r => `=IF($D${r}="","",IFERROR($E${r}/$I${r},""))`,            // 运营新增成本 = 消耗/新增用户
  I: r => prodIdx(r, 'E'),                                          // 新增用户
  J: r => prodIdx(r, 'F'),                                          // 活跃用户
  K: r => prodIdx(r, 'K'),                                          // 人均进入次数
  L: r => prodIdx(r, 'L'),                                          // 每位用户平均时长(分)
  M: r => prodIdx(r, 'N'),                                          // 平均启动速度(秒)
  N: r => prodIdx(r, 'O'),                                          // 平均首次启动速度(秒)
  O: r => prodIdx(r, 'P'),                                          // 启动成功率
  P: r => prodIdx(r, 'Z'),                                          // eCPM
  Q: r => prodIdx(r, 'Y'),                                          // 广告点击率
  R: r => prodIdx(r, 'AA'),                                         // 人均广告展示次数
  S: r => prodIdx(r, 'AB'),                                         // 广告总收入
  U: r => `=COUNTA(${PROD}!$C$2:$C$5000)-ROW()+2`,                  // _srcN 辅助列(倒序源行号)
  V: r => `=IF($D${r}="","",IF(AND(N($E${r})=0,N($S${r})=0),0,1))`, // _show: 消耗+广告总收入都为0则0(隐藏)
};

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
async function writeFormulas(token, targetRow) {
  for (const [col, gen] of Object.entries(COLS)) {
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
async function applyFormats(token, targetRow) {
  const setFmt = (range, formatter) => feishuReq('PUT',
    `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/style`, token,
    { appendStyle: { range, style: { formatter } } });
  let r;
  r = await setFmt(`${REPORT_SHEET_ID}!B2:B${targetRow}`, 'yyyy/MM/dd');
  if (r.code !== 0) console.warn('  [warn] B date fmt:', JSON.stringify(r).slice(0, 120));
  r = await setFmt(`${REPORT_SHEET_ID}!F2:F${targetRow}`, '0.00%');
  if (r.code !== 0) console.warn('  [warn] F pct fmt:', JSON.stringify(r).slice(0, 120));
}

// Hide a leftover empty row in the report? N/A. Hide helper columns U:V.
async function hideHelperCols(token) {
  const r = await feishuReq('PUT',
    `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/dimension_range`, token,
    { dimension: { sheetId: REPORT_SHEET_ID, majorDimension: 'COLUMNS', startIndex: 21, endIndex: 22 },
      dimensionProperties: { visible: false } });
  if (r.code !== 0) console.warn('  [warn] hide U:V:', JSON.stringify(r).slice(0, 120));
}

// Show only rows where _show (col V) > 0, i.e. hide rows whose 消耗 AND 广告总收入 are both 0.
async function applyFilter(token, targetRow) {
  // delete existing filter first (idempotent), then create
  await feishuReq('DELETE',
    `/open-apis/sheets/v3/spreadsheets/${SPREADSHEET_TOKEN}/sheets/${REPORT_SHEET_ID}/filter`, token).catch(() => {});
  const r = await feishuReq('POST',
    `/open-apis/sheets/v3/spreadsheets/${SPREADSHEET_TOKEN}/sheets/${REPORT_SHEET_ID}/filter`, token,
    { range: `${REPORT_SHEET_ID}!A1:V${targetRow}`, col: 'V',
      condition: { filter_type: 'number', compare_type: 'greater', expected: ['0'] } });
  if (r.code !== 0) console.warn('  [warn] set filter:', JSON.stringify(r).slice(0, 150));
}

async function ensureReportFormulas(token) {
  const dataCount = await getProductDataCount(token);
  const targetRow = dataCount + 1 + ROW_BUFFER; // +1 header offset
  console.log(`  product data rows: ${dataCount}, filling report rows 2..${targetRow}`);
  // headers for helper cols U(_srcN) and V(_show)
  await feishuReq('PUT', `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values`, token,
    { valueRange: { range: `${REPORT_SHEET_ID}!U1:V1`, values: [['_srcN', '_show']] } });
  await writeFormulas(token, targetRow);
  await applyFormats(token, targetRow);
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
