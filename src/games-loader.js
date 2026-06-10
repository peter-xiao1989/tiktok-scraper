const https = require('https');

// Game list lives in the 产品id及链接 sheet (项目组 | 产品名 | id), which the user
// maintains and which includes the 齿轮/战车 games — unlike the old Bitable.
const SPREADSHEET_TOKEN = 'J8mswO2vziyIAAkdt4rcVeaDnog';
const GAMES_SHEET_ID    = 'juQobR';

function httpGet(path, token) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: 'open.feishu.cn', path, method: 'GET',
      headers: { 'Authorization': 'Bearer ' + token }
    }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => { const buf = Buffer.concat(chunks).toString('utf8'); try { resolve(JSON.parse(buf)); } catch { resolve(buf); } });
    });
    req.on('error', reject); req.end();
  });
}

async function getTenantToken(appId, appSecret) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ app_id: appId, app_secret: appSecret });
    const req = https.request({ hostname: 'open.feishu.cn',
      path: '/open-apis/auth/v3/tenant_access_token/internal', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let buf = ''; res.on('data', c => buf += c);
      res.on('end', () => {
        const p = JSON.parse(buf);
        if (p.code !== 0) reject(new Error('Feishu auth: ' + p.msg));
        else resolve(p.tenant_access_token);
      });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

async function loadGames(appId, appSecret) {
  const token = await getTenantToken(appId, appSecret);
  const res = await httpGet(
    `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values/${GAMES_SHEET_ID}!A2:C200`,
    token
  );
  const rows = res.data?.valueRange?.values || [];
  return rows
    .map(r => ({
      group: (r[0] == null ? '' : String(r[0])).trim(),
      name:  (r[1] == null ? '' : String(r[1])).trim(),
      id:    (r[2] == null ? '' : String(r[2])).trim(),
    }))
    .filter(g => g.id && g.name);
}

module.exports = { loadGames };
