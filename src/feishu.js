const https = require('https');

const FEISHU_BASE = 'https://open.feishu.cn';

// 39 columns total (A–AM)
const COLUMNS = [
  // A-B: 基本信息
  '游戏名称','统计周期',
  // C-G: 用户行为
  '新增用户','活跃用户','重复用户','有效用户','总用户数',
  // H-K: 启动/时长
  '总启动次数','人均进入次数','每位用户平均时长(分)','次均游戏时长(分)',
  // L-O: 表现
  '平均启动速度(秒)','平均首次启动速度(秒)','启动成功率','授权成功率',
  // P-S: 留存
  '次留','7日留存','14日留存','30日留存',
  // T-Z: IAA变现
  '广告请求量','广告曝光量','广告点击量','广告点击率','eCPM','人均广告展示次数','广告总收入',
  // AA-AC: 推荐页广告-概览
  '推荐页_广告支出','推荐页_已激活用户','推荐页_付费流量收入',
  // AD-AJ: 推荐页广告-首日激活
  '推荐页_首日激活用户','推荐页_首日ARPU','推荐页_首日eCPM','推荐页_首日LTV','推荐页_首日ROI','推荐页_用户激活成本','推荐页_首日付费收入',
  // AK-AM: 推荐页广告-历史激活
  '推荐页_历史激活用户','推荐页_历史eCPM','推荐页_历史付费收入',
];

const ROW_KEY_MAP = {
  '游戏名称': '游戏名称',
  '统计周期': '统计周期',
  '新增用户': '新增用户',
  '活跃用户': '活跃用户',
  '重复用户': '重复用户',
  '有效用户': '有效用户',
  '总用户数': '总用户数',
  '总启动次数': '总启动次数',
  '人均进入次数': '人均进入次数',
  '每位用户平均时长(分)': '每位用户平均时长_分',
  '次均游戏时长(分)': '次均游戏时长_分',
  '平均启动速度(秒)': '平均启动速度_秒',
  '平均首次启动速度(秒)': '平均首次启动速度_秒',
  '启动成功率': '启动成功率',
  '授权成功率': '授权成功率',
  '次留': '次留',
  '7日留存': '七日留存',
  '14日留存': '十四日留存',
  '30日留存': '三十日留存',
  '广告请求量': '广告请求量',
  '广告曝光量': '广告曝光量',
  '广告点击量': '广告点击量',
  '广告点击率': '广告点击率',
  'eCPM': 'eCPM',
  '人均广告展示次数': '人均广告展示次数',
  '广告总收入': '广告总收入',
  '推荐页_广告支出': '推荐页_广告支出',
  '推荐页_已激活用户': '推荐页_已激活用户',
  '推荐页_付费流量收入': '推荐页_付费流量收入',
  '推荐页_首日激活用户': '推荐页_首日激活用户',
  '推荐页_首日ARPU': '推荐页_首日ARPU',
  '推荐页_首日eCPM': '推荐页_首日eCPM',
  '推荐页_首日LTV': '推荐页_首日LTV',
  '推荐页_首日ROI': '推荐页_首日ROI',
  '推荐页_用户激活成本': '推荐页_用户激活成本',
  '推荐页_首日付费收入': '推荐页_首日付费收入',
  '推荐页_历史激活用户': '推荐页_历史激活用户',
  '推荐页_历史eCPM': '推荐页_历史eCPM',
  '推荐页_历史付费收入': '推荐页_历史付费收入',
};

function colLetter(n) {
  let col = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    col = String.fromCharCode(65 + r) + col;
    n = Math.floor((n - 1) / 26);
  }
  return col;
}

function httpPost(url, token, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const urlObj = new URL(url);
    const req = https.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch { resolve(buf); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function httpGet(url, token) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = https.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` },
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch { resolve(buf); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function getTenantToken(appId, appSecret) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ app_id: appId, app_secret: appSecret });
    const req = https.request({
      hostname: 'open.feishu.cn',
      path: '/open-apis/auth/v3/tenant_access_token/internal',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        const parsed = JSON.parse(buf);
        if (parsed.code !== 0) reject(new Error(`Feishu auth failed: ${parsed.msg}`));
        else resolve(parsed.tenant_access_token);
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function getLastRow(token, spreadsheetToken, sheetId) {
  const url = `${FEISHU_BASE}/open-apis/sheets/v3/spreadsheets/${spreadsheetToken}/sheets/${sheetId}`;
  const res = await httpGet(url, token);
  return res?.data?.sheet?.grid_properties?.row_count ?? 1;
}

function rowToValues(row) {
  return COLUMNS.map(col => {
    const key = ROW_KEY_MAP[col];
    const val = row[key] ?? '';
    return val === '' ? '' : val;
  });
}

async function appendRows(rows, { appId, appSecret, spreadsheetToken, sheetId }) {
  const token = await getTenantToken(appId, appSecret);

  // Find next empty row by appending after existing data
  const appendUrl = `${FEISHU_BASE}/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values_append?insertDataOption=INSERT_ROWS`;

  const values = rows.map(rowToValues);
  const lastCol = colLetter(COLUMNS.length);
  const range = `${sheetId}!A1:${lastCol}${rows.length}`;

  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      valueRange: { range, values }
    });
    const req = https.request({
      hostname: 'open.feishu.cn',
      path: `/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values_append?insertDataOption=INSERT_ROWS`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch { resolve(buf); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function writeHeaders({ appId, appSecret, spreadsheetToken, sheetId }) {
  const token = await getTenantToken(appId, appSecret);
  const lastCol = colLetter(COLUMNS.length);
  const range = `${sheetId}!A1:${lastCol}1`;
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ valueRange: { range, values: [COLUMNS] } });
    const req = https.request({
      hostname: 'open.feishu.cn',
      path: `/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values`,
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve(buf); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

module.exports = { getTenantToken, appendRows, writeHeaders, COLUMNS };
