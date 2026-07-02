/**
 * 一次性抓取 TikTok 创意中心登录态。双保险判定登录：
 *   信号A：拦截到趋势/TopAds 接口返回 code:0（匿名是 40101，只有登录态才 0）
 *   信号B：出现会话 cookie（名字含 sid/sess/passport/uid_tt/sso/ucp）
 * 登录成功前绝不关窗口；最多 15 分钟。每 8 秒打印一次现状（诊断用）。
 * 用法：node src/cc-capture.js   登录到能看到榜单后会自动保存 data/cc-auth-state.json。
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const STATE = path.join(__dirname, '../data/cc-auth-state.json');
const DEADLINE_MS = 15 * 60 * 1000;
// 只认真正的登录态 cookie（排除 csrf：passport_csrf_token 访问登录页就有，不是登录成功）
const SESSION_NAMES = ['sessionid', 'sessionid_ss', 'sid_tt', 'sid_guard', 'uid_tt', 'sso_uid_tt', 'sid_ucp_v1', 'ssid_ucp_v1', 'cmpl_token'];
const isSession = name => SESSION_NAMES.includes(name);

(async () => {
  const browser = await chromium.launch({ headless: false, args: ['--start-maximized'] });
  const ctx = await browser.newContext({ viewport: null, locale: 'en-US' });
  const page = await ctx.newPage();
  let apiOk = false;
  page.on('response', async res => {
    const u = res.url();
    if (!/creative_radar_api|popular_trend|top_ads/.test(u)) return;
    try { const j = await res.json(); if (j && j.code === 0 && j.data) apiOk = true; } catch {}
  });

  console.log('浏览器已弹出。请在该窗口登录创意中心（账号密码 + 过验证码），直到能看到榜单数据。');
  console.log('（登录前不会关窗口，最多 15 分钟。登录后请确保停留在趋势榜页面让数据加载出来。）');
  await page.goto('https://ads.tiktok.com/business/creativecenter/inspiration/popular/hashtag/pc/en?region=US&period=7', { waitUntil: 'domcontentloaded' }).catch(() => {});

  const start = Date.now();
  let saved = false;
  while (Date.now() - start < DEADLINE_MS) {
    await new Promise(r => setTimeout(r, 8000));
    let cookies = [];
    try { cookies = await ctx.cookies(); } catch {}
    const sess = cookies.filter(c => isSession(c.name)).map(c => c.name);
    const t = Math.round((Date.now() - start) / 1000);
    console.log(`[${t}s] cookie 共 ${cookies.length} 个，会话类 ${sess.length} 个 [${sess.slice(0, 6).join(',')}]，趋势接口 code0=${apiOk}`);
    if (apiOk || sess.length >= 1) {
      await new Promise(r => setTimeout(r, 4000));   // 等 cookie 落齐
      fs.mkdirSync(path.dirname(STATE), { recursive: true });
      await ctx.storageState({ path: STATE });
      const all = (await ctx.cookies()).length;
      console.log(`\n✅ 判定已登录（接口code0=${apiOk}, 会话cookie=${sess.length}）。已保存 ${STATE}（${all} 个 cookie）`);
      saved = true;
      break;
    }
  }
  if (!saved) console.log('\n⏱ 没检测到登录（接口未返回 code0、也无会话 cookie）。你登录成功了吗？重跑再试，或把这段日志发我。');
  await browser.close();
  process.exit(saved ? 0 : 1);
})();
