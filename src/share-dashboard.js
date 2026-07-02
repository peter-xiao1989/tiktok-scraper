/**
 * 截 KQL 经分后台页面 → 发飞书群(图片+文字摘要)。
 * B 方案(Playwright CI)。图片需飞书 app 传 image_key(占租户配额);配额满时降级纯文字。
 *
 * env: DASHBOARD_URL, SESSION_SECRET(伪造 admin 会话), FEISHU_APP_ID/SECRET, SHARE_WEBHOOK
 * 用法: PAGE=realtime node src/share-dashboard.js   |   PAGE=overview ...
 */
const crypto = require('crypto');
const https = require('https');
const { chromium } = require('playwright');

const DASH = (process.env.DASHBOARD_URL || 'https://tiktok-analytics.xiaohuipeng123.workers.dev').replace(/\/$/, '');
const SECRET = process.env.SESSION_SECRET;
const WEBHOOK = process.env.SHARE_WEBHOOK;
const PAGE = process.env.PAGE || 'overview';
const b64url = b => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function adminCookie() {
  const exp = Date.now() + 3600000;
  const payload = b64url(Buffer.from(`admin:admin:${exp}`));
  const sig = b64url(crypto.createHmac('sha256', SECRET).update(payload).digest());
  return `${payload}.${sig}`;
}
function post(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url), data = JSON.stringify(body);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(b); } }); });
    req.on('error', reject); req.write(data); req.end();
  });
}
async function tenantToken() {
  const r = await post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', { app_id: process.env.FEISHU_APP_ID, app_secret: process.env.FEISHU_APP_SECRET });
  return r.tenant_access_token;
}
// 上传图片 → image_key(multipart);配额满返回 null
function uploadImage(token, buf) {
  return new Promise(resolve => {
    const boundary = '----kql' + Date.now();
    const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image_type"\r\n\r\nmessage\r\n--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="s.png"\r\nContent-Type: image/png\r\n\r\n`);
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([head, buf, tail]);
    const req = https.request({ hostname: 'open.feishu.cn', path: '/open-apis/im/v1/images', method: 'POST', headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length } }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { const j = JSON.parse(b); resolve(j.code === 0 ? j.data.image_key : null); } catch { resolve(null); } }); });
    req.on('error', () => resolve(null)); req.write(body); req.end();
  });
}

async function summary(cookie) {
  const get = path => new Promise((resolve) => { const u = new URL(DASH + path); https.get({ hostname: u.hostname, path: u.pathname + u.search, headers: { Cookie: 'ta=' + cookie } }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve({}); } }); }).on('error', () => resolve({})); });
  const m = v => '$' + Math.round(v || 0).toLocaleString();
  const pc = v => (v == null ? '—' : (v * 100).toFixed(1) + '%');
  if (PAGE === 'realtime') {
    const d = await get('/api/realtime'); const k = d.kpi || {};
    return `📊 实时数据 截至 ${String(d.now ?? 0).padStart(2, '0')}:00\n累计消耗 ${m(k.spend)} ｜ D0ROI ${pc(k.roi)}\n手动 ${m(k.manual_spend)}/${pc(k.manual_roi)} ｜ 自动 ${m(k.auto_spend)}/${pc(k.auto_roi)}\n🔴风险 ${k.warnings || 0}`;
  }
  const d = await get('/api/dashboard?days=30'); const t = (d.kpi || {}).today || {}, mo = (d.kpi || {}).month || {};
  return `📊 经营日报 ${t.date || ''}\n昨日 消耗 ${m((t.spend || {}).v)} ｜ 收入 ${m((t.revenue || {}).v)} ｜ D0ROI ${pc((t.first_roi || {}).v)}\n本月 消耗 ${m(mo.spend)} ｜ 收入(含补贴) ${m(mo.revenue_after)} ｜ 营收ROI ${pc(mo.rev_roi)}/含补贴${pc(mo.roi_subsidized)}\n累计ROI ${pc(d.cum_roi)}`;
}

async function main() {
  if (!SECRET || !WEBHOOK) throw new Error('缺 SESSION_SECRET / SHARE_WEBHOOK');
  const cookie = adminCookie();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 2200 }, deviceScaleFactor: 2 });
  await ctx.addCookies([{ name: 'ta', value: cookie, domain: new URL(DASH).hostname, path: '/' }]);
  const page = await ctx.newPage();
  await page.goto(DASH, { waitUntil: 'networkidle' });
  await page.click(`.nav-item[data-tab="${PAGE}"]`).catch(() => {});
  await page.waitForTimeout(5000);   // 等 ECharts 渲染
  let clip = null;
  if (PAGE === 'realtime') {
    clip = await page.evaluate(() => {
      const panel = document.querySelector('#panel-realtime'); const pacing = document.querySelector('#ch-rt-pacing')?.closest('.card');
      if (!panel || !pacing) return null;
      const p = panel.getBoundingClientRect(), c = pacing.getBoundingClientRect();
      return { x: Math.max(0, p.left), y: Math.max(0, p.top + window.scrollY), width: p.width, height: c.bottom + window.scrollY - (p.top + window.scrollY) + 12 };
    });
  }
  const buf = await page.screenshot({ fullPage: PAGE !== 'realtime', clip: clip || undefined });
  await browser.close();

  if (process.env.SAVE) { require('fs').writeFileSync(process.env.SAVE, buf); console.log('已存', process.env.SAVE, buf.length, 'bytes'); return; }

  const text = await summary(cookie);
  let imageKey = null;
  try { const tok = await tenantToken(); if (tok) imageKey = await uploadImage(tok, buf); } catch {}
  await post(WEBHOOK, { msg_type: 'text', content: { text } });
  if (imageKey) await post(WEBHOOK, { msg_type: 'image', content: { image_key: imageKey } });
  console.log(`分享完成 page=${PAGE} 图片=${imageKey ? '已附' : '配额满,纯文字'}`);
}
main().catch(e => { console.error('ERR', e.message); process.exit(1); });
