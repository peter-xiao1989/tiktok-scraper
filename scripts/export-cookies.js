/**
 * 导出 TikTok Developer Portal cookies。
 * - 有 EMAIL_163_PASS 时：全自动（自动填表 + IMAP 读验证码）
 * - 没有时：打开有头浏览器让你手动登录
 * 用法：npm run export-cookies
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const EMAIL = process.env.TIKTOK_EMAIL || '';
const PASSWORD = process.env.TIKTOK_PASSWORD || '';
const BASE = 'https://developers.tiktok.com';

async function main() {
  const hasImap = !!process.env.EMAIL_163_PASS;
  const headless = hasImap; // 有 IMAP 就无头全自动，否则有头让用户手动操作

  console.log(hasImap
    ? '[export-cookies] Auto mode (EMAIL_163_PASS set) — headless'
    : '[export-cookies] Manual mode — browser will open, please log in');

  const browser = await chromium.launch({ headless, slowMo: headless ? 0 : 50 });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  await page.goto(`${BASE}/login`, { waitUntil: 'load', timeout: 30000 });

  if (hasImap) {
    // Auto-fill credentials
    await page.locator('input[placeholder="Email"]').fill(EMAIL);
    await page.locator('input[placeholder="Password"]').fill(PASSWORD);
    await page.waitForFunction(
      () => !document.querySelector('button[type="submit"]')?.disabled,
      { timeout: 10000 }
    );
    await page.locator('button[type="submit"]').click();

    // Wait for redirect or verification form
    const redirected = await page
      .waitForURL(url => !url.includes('/login'), { timeout: 20000 })
      .then(() => true).catch(() => false);

    if (!redirected) {
      const { handleEmailVerification } = require('../src/auth');
      // Use auth.js helper if exported, or inline it
      const { waitForTikTokCode } = require('../src/email-code');
      const VERIFY_SELS = ['input[maxlength="6"]', 'input[maxlength="4"]', 'input[placeholder*="code" i]'];
      let verifyInput = null;
      for (const sel of VERIFY_SELS) {
        const el = await page.$(sel).catch(() => null);
        if (el) { verifyInput = el; break; }
      }
      if (verifyInput) {
        const code = await waitForTikTokCode({ timeout: 120000 });
        await verifyInput.fill(code);
        const btn = await page.$('button[type="submit"], button:has-text("Verify"), button:has-text("确认")').catch(() => null);
        if (btn) await btn.click();
        await page.waitForURL(url => !url.includes('/login'), { timeout: 30000 });
      } else {
        console.error('[export-cookies] No verification input found. Check the page manually.');
        await browser.close();
        process.exit(1);
      }
    }
  } else {
    console.log('[export-cookies] Waiting for manual login (URL must leave /login)...');
    await page.waitForURL(url => !url.includes('/login'), { timeout: 300000 });
  }

  const state = await context.storageState();
  await browser.close();

  const out = JSON.stringify(state);
  const outFile = path.join(__dirname, '../data/tiktok-cookies.json');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, out);

  console.log('\n✅ Cookies saved to data/tiktok-cookies.json');
  console.log('\nSet as GitHub Secret:');
  console.log('  gh secret set TIKTOK_COOKIES < data/tiktok-cookies.json');
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
