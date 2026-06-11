#!/usr/bin/env node
// 仪表盘长图快照:Playwright 打开分享链接 → 整页截图 → 上传飞书 → webhook 发图。
// 用法: SHARE_URL=... FEISHU_WEBHOOK=... node scripts/snapshot-dashboard.js
const { chromium } = require('playwright');
const https = require('https');
const fs = require('fs');

const SHARE_URL = process.env.SHARE_URL || 'https://wcnr1w3cariy.feishu.cn/share/base/dashboard/shrcn0U0hK0GMbcqw0NZeoXSNGf';
const WEBHOOK = process.env.FEISHU_WEBHOOK;
const APP_ID = process.env.FEISHU_APP_ID || 'cli_aa898a664d395cc2';
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const OUT = '/tmp/dashboard_snapshot.png';

function req(method, url, headers, body) {
  return new Promise((res, rej) => {
    const u = new URL(url);
    const r = https.request({ hostname: u.hostname, path: u.pathname + u.search, method, headers }, rs => {
      const c = []; rs.on('data', x => c.push(x)); rs.on('end', () => { try { res(JSON.parse(Buffer.concat(c).toString())); } catch (e) { res({ raw: Buffer.concat(c).toString().slice(0, 200) }); } });
    });
    r.on('error', rej); if (body) r.write(body); r.end();
  });
}

async function main() {
  // 1) 截图
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
  await page.goto(SHARE_URL, { waitUntil: 'networkidle', timeout: 90000 }).catch(() => {});
  await page.waitForTimeout(12000);  // 等图表渲染
  // 滚到底触发懒加载,再回顶
  await page.evaluate(async () => {
    const sc = document.scrollingElement || document.body;
    for (let y = 0; y < sc.scrollHeight; y += 800) { sc.scrollTo(0, y); await new Promise(r => setTimeout(r, 350)); }
    sc.scrollTo(0, 0);
  }).catch(() => {});
  await page.waitForTimeout(4000);
  await page.screenshot({ path: OUT, fullPage: true });
  await browser.close();
  const kb = Math.round(fs.statSync(OUT).size / 1024);
  console.log(`截图完成 ${kb}KB`);

  // 2) 上传图片(multipart)
  const tok = (await req('POST', 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    { 'Content-Type': 'application/json' }, JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }))).tenant_access_token;
  const boundary = '----fb' + Date.now();
  const img = fs.readFileSync(OUT);
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image_type"\r\n\r\nmessage\r\n--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="dash.png"\r\nContent-Type: image/png\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([head, img, tail]);
  const up = await req('POST', 'https://open.feishu.cn/open-apis/im/v1/images',
    { Authorization: 'Bearer ' + tok, 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': body.length }, body);
  const key = up.data?.image_key;
  if (!key) throw new Error('upload failed: ' + JSON.stringify(up).slice(0, 200));
  console.log('image_key:', key);

  // 3) webhook 发图
  if (!WEBHOOK) { console.log('无 FEISHU_WEBHOOK,跳过发送'); return; }
  const r = await req('POST', WEBHOOK, { 'Content-Type': 'application/json' },
    JSON.stringify({ msg_type: 'image', content: { image_key: key } }));
  console.log('发送:', JSON.stringify(r).slice(0, 120));
}
main().catch(e => { console.error('ERR', e.message); process.exit(1); });
