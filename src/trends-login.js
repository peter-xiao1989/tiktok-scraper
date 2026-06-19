/**
 * 创意中心登录态：返回一个已登录的浏览器 context（登录后 View More 翻页/行业迭代解锁）。
 * 优先用缓存 storageState（data/cc-auth-state.json / 环境变量 CC_COOKIES），否则走账号登录 + 邮箱验证码。
 * 复用 ads-probe 的登录路子（business.tiktok.com → 同 TikTok Business 身份，cookie 跨 ads.tiktok.com 创意中心）。
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const STATE = path.join(__dirname, '../data/cc-auth-state.json');
// 优先用 TIKTOK_EMAIL(163 账号)——它的验证码 email-code.js 能从 163 IMAP 读到；ADS_EMAIL(peter@kuaiql.com)的码读不到。
const EMAIL = process.env.TIKTOK_EMAIL || process.env.ADS_EMAIL || '';
const PASSWORD = process.env.TIKTOK_PASSWORD || process.env.ADS_PASSWORD || '';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const CC_PROBE = 'https://ads.tiktok.com/business/creativecenter/inspiration/popular/hashtag/pc/en?region=US&period=7';

// 登录态判定：创意中心趋势页若仍重定向到登录墙 SPA 或出现登录按钮 = 未登录
async function isLoggedIn(page) {
  await page.goto(CC_PROBE, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(5000);
  const u = page.url();
  if (/\/login|passport|signup/i.test(u)) return false;
  // 趋势页若能渲染出榜单内容（非登录墙），视为已登录
  const hasLogin = await page.$('text=/Log in|Sign up|登录/i').then(Boolean).catch(() => false);
  return !hasLogin;
}

async function doLogin(ctx) {
  const page = await ctx.newPage();
  // 走 business.tiktok.com 报表页触发登录重定向（与 ads-probe 同路）
  await page.goto('https://ads.tiktok.com/i18n/login/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(3000);
  // 切到邮箱登录
  try { await page.locator('text=/Email|邮箱/i').first().click({ timeout: 5000 }); } catch {}
  await page.waitForSelector('input[type="password"]', { timeout: 20000 });
  await page.locator('input[name="email"], input[type="text"][placeholder*="mail" i], input[type="email"]').first().fill(EMAIL).catch(() => {});
  await page.waitForTimeout(400);
  await page.locator('input[type="password"]').first().fill(PASSWORD).catch(() => {});
  await page.waitForTimeout(400);
  await page.locator('button:has-text("Log in"), button:has-text("登录"), button[type="submit"]').first().click().catch(() => {});
  console.log('[cc-login] 已提交，等待跳转/验证…');
  await page.waitForTimeout(6000);
  try { await page.screenshot({ path: path.join(__dirname, '../data/cc-login-1.png') }); } catch {}

  // 邮箱验证码（若出现）
  const codeInput = await page.$('input[placeholder*="code" i], input[placeholder*="验证" i], input[maxlength="6"]').catch(() => null);
  if (codeInput) {
    console.log('[cc-login] 需邮箱验证码，IMAP 读取中…');
    try {
      const { waitForTikTokCode } = require('./email-code');
      const code = await waitForTikTokCode({ timeout: 120000 });
      await codeInput.fill(code);
      await page.locator('button:has-text("Verify"), button:has-text("Next"), button:has-text("确定"), button[type="submit"]').first().click().catch(() => {});
      await page.waitForTimeout(6000);
    } catch (e) { console.log('[cc-login] 验证码失败:', e.message); }
  }
  try { await page.screenshot({ path: path.join(__dirname, '../data/cc-login-2.png') }); } catch {}
  await page.close();
}

async function loggedInContext(browser) {
  // 1) env CC_COOKIES（预存 storageState JSON）
  if (process.env.CC_COOKIES && !fs.existsSync(STATE)) {
    try { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, process.env.CC_COOKIES); } catch {}
  }
  // 2) 缓存 storageState
  if (fs.existsSync(STATE)) {
    const ctx = await browser.newContext({ storageState: STATE, userAgent: UA, locale: 'en-US', viewport: { width: 1440, height: 1000 } });
    const p = await ctx.newPage();
    if (await isLoggedIn(p)) { console.log('[cc-login] 复用缓存登录态'); await p.close(); return ctx; }
    await p.close(); await ctx.close();
    console.log('[cc-login] 缓存登录态失效，重新登录');
  }
  // 3) 全新登录
  if (!PASSWORD) throw new Error('缺少 ADS_PASSWORD/TIKTOK_PASSWORD，无法登录');
  const ctx = await browser.newContext({ userAgent: UA, locale: 'en-US', viewport: { width: 1440, height: 1000 } });
  await doLogin(ctx);
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  await ctx.storageState({ path: STATE });
  const p = await ctx.newPage();
  const ok = await isLoggedIn(p);
  await p.close();
  console.log('[cc-login] 登录结果:', ok ? '成功' : '仍未登录(看 data/cc-login-*.png)');
  return ctx;
}

module.exports = { loggedInContext, isLoggedIn };
