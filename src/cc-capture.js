/**
 * 一次性抓取 TikTok 创意中心登录态（绕过验证码：你人工登录一次，脚本存会话）。
 * 用法：node src/cc-capture.js
 *   1. 会弹出浏览器，自动打开 TikTok for Business 登录页；
 *   2. 你手动登录（输账号密码 + 过验证码），直到能看到创意中心趋势页内容；
 *   3. 回到终端按回车 —— 脚本把会话存到 data/cc-auth-state.json，并打印一行可直接当 GitHub secret 的内容。
 * 之后把该文件内容设为 CC_COOKIES secret，每日登录深抓就用它，不再需要登录。会话通常能用数天~数周，失效了再跑一次本脚本。
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const STATE = path.join(__dirname, '../data/cc-auth-state.json');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US' });
  const page = await ctx.newPage();
  console.log('\n打开登录页中…请在弹出的浏览器里手动登录（过验证码），直到能看到创意中心趋势榜内容。');
  await page.goto('https://ads.tiktok.com/business/creativecenter/inspiration/popular/hashtag/pc/en?region=US&period=7', { waitUntil: 'domcontentloaded' }).catch(() => {});

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise(r => rl.question('\n>>> 登录完成、能看到榜单后，回到这里按【回车】保存会话… ', () => { rl.close(); r(); }));

  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  await ctx.storageState({ path: STATE });
  const raw = fs.readFileSync(STATE, 'utf8');
  console.log(`\n✅ 已保存会话到 ${STATE}（${raw.length} 字节）`);
  console.log('\n下一步二选一：');
  console.log('  A. 直接发我这个文件，我帮你设成 CC_COOKIES secret（需你授权改 secret）；');
  console.log('  B. 自己设：  gh secret set CC_COOKIES < data/cc-auth-state.json   （在 tiktok-scraper 目录）');
  await browser.close();
})();
