/**
 * Load the game roster from the 产品id及链接 sheet (juQobR) in the main
 * spreadsheet — the user-maintained source of truth for 项目组/产品名/id.
 * (Replaces the old bitable config table, which was deleted.)
 * Rows without an id are skipped for scraping (their games can still appear
 * in 投放-side tables); fill in the id to bring a game into the product pipeline.
 */
const https = require('https');

const SPREADSHEET_TOKEN = 'J8mswO2vziyIAAkdt4rcVeaDnog';
const GAMES_SHEET_ID = 'juQobR';   // 产品id及链接: A=项目组 B=产品名 C=id

function httpGet(path, token) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: 'open.feishu.cn', path, method: 'GET',
      headers: { 'Authorization': 'Bearer ' + token }
    }, res => {
      let buf = ''; res.on('data', c => buf += c);
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve(buf); } });
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
  const games = rows
    .map(r => ({
      group: String(r[0] ?? '').trim(),
      name:  String(r[1] ?? '').trim(),
      id:    String(r[2] ?? '').trim(),
    }))
    .filter(g => g.id && g.name);
  if (!games.length) throw new Error('产品id及链接 returned no games with id — refusing to scrape an empty roster');
  return games;
}

module.exports = { loadGames };
