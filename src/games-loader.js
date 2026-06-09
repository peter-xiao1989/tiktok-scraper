const https = require('https');

const BITABLE_APP  = process.env.FEISHU_BITABLE_TOKEN || 'HCXKb9qoDaiEmqsl4cocOnNPnpb';
const PRODUCT_TABLE = 'tblPWZSoCf4Tqd4n';

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
    `/open-apis/bitable/v1/apps/${BITABLE_APP}/tables/${PRODUCT_TABLE}/records?page_size=100`,
    token
  );
  const items = res.data?.items || [];
  return items
    .map(r => ({
      group: r.fields['项目组'] || '',
      name:  r.fields['产品名'] || '',
      id:    r.fields['id'] || '',
    }))
    .filter(g => g.id && g.name);
}

module.exports = { loadGames };
