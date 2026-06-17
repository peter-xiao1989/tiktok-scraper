/**
 * TikTok Developer Portal 登录模块。优先级：
 * 1. TIKTOK_COOKIES 环境变量（预存 storageState JSON，跳过浏览器登录）
 * 2. data/auth-state.json 本地缓存
 * 3. 浏览器自动登录（自动填表 + 若触发邮件验证则 IMAP 读码）
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '../data/auth-state.json');
const EMAIL = process.env.TIKTOK_EMAIL || '';
const PASSWORD = process.env.TIKTOK_PASSWORD || '';
const BASE = 'https://developers.tiktok.com';

const SESSION_NAMES = ['sid_guard_tt_open', 'sessionid', 'ssid_ucp_v1_open', 'sid_tt'];

function isStateValid(state) {
  const cookies = state?.cookies || [];
  const now = Date.now() / 1000;
  return cookies.some(c =>
    SESSION_NAMES.includes(c.name) &&
    (!c.expires || c.expires < 0 || c.expires > now)
  );
}

async function ensureLoggedIn() {
  // Priority 1: TIKTOK_COOKIES env (GitHub Secret, bypasses browser)
  const envCookies = process.env.TIKTOK_COOKIES;
  if (envCookies) {
    try {
      const state = JSON.parse(envCookies);
      if (isStateValid(state)) {
        console.log('[auth] Using TIKTOK_COOKIES env');
        fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
        fs.writeFileSync(STATE_FILE, JSON.stringify(state));
        return state;
      }
      console.warn('[auth] TIKTOK_COOKIES expired, falling through to browser login');
    } catch (e) {
      console.warn('[auth] TIKTOK_COOKIES parse error:', e.message);
    }
  }

  // Priority 2: local cache
  if (fs.existsSync(STATE_FILE)) {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (isStateValid(state)) {
      console.log('[auth] Using cached session');
      return state;
    }
  }

  // Priority 3: browser login with auto verification handling
  return browserLogin();
}

async function browserLogin() {
  console.log('[auth] Browser login started');
  // 隐身启动:降低无头浏览器被反爬识别概率(之前点击后被打回空登录页 = 典型自动化拦截)
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'Asia/Shanghai',
  });
  // 抹掉 navigator.webdriver 等自动化指纹
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
  });
  const page = await context.newPage();

  try {
    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.locator('input[placeholder="Email"]').fill(EMAIL);
    await page.waitForTimeout(400 + Math.random() * 400);
    await page.locator('input[placeholder="Password"]').fill(PASSWORD);
    await page.waitForTimeout(400 + Math.random() * 400);
    await page.locator('button[type="submit"]').waitFor({ state: 'visible', timeout: 15000 });
    await page.screenshot({ path: path.join(__dirname, '../data/before-click.png'), fullPage: true }).catch(() => {});
    await page.locator('button[type="submit"]').click({ timeout: 30000 });
    // 兜底:部分前端不响应 click,补一次回车提交
    await page.locator('input[placeholder="Password"]').press('Enter').catch(() => {});

    // Wait up to 20s for redirect. If still on /login, assume email verification.
    const redirected = await page
      .waitForURL(url => !url.toString().includes('/login'), { timeout: 20000 })
      .then(() => true)
      .catch(() => false);

    // 仍在 /login 时,把页面可见报错文字打到日志,便于判断是密码错/验证码/风控
    if (!redirected) {
      const errText = await page.evaluate(() => {
        const hits = [];
        document.querySelectorAll('[class*="error" i],[class*="toast" i],[role="alert"],[class*="tip" i]').forEach(e => { const t = (e.innerText || '').trim(); if (t) hits.push(t); });
        return hits.slice(0, 5).join(' | ');
      }).catch(() => '');
      if (errText) console.log(`[auth] 登录页提示文字: ${errText}`);
    }

    if (!redirected) {
      console.log('[auth] Still on /login after 20s — attempting email verification via IMAP');
      await handleEmailVerification(page);
    }

    if (page.url().includes('/login')) {
      throw new Error('Still on /login after verification attempt');
    }

    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    await context.storageState({ path: STATE_FILE });
    console.log('[auth] Login successful');
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));

  } catch (e) {
    const screenshotPath = path.join(__dirname, '../data/login-failure.png');
    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    throw new Error(`Login failed: ${e.message}`);
  } finally {
    await browser.close();
  }
}

async function handleEmailVerification(page) {
  const { waitForTikTokCode } = require('./email-code');

  // Find the verification code input (TikTok typically shows a single 6-digit input)
  const VERIFY_SELECTORS = [
    'input[maxlength="6"]',
    'input[maxlength="4"]',
    'input[type="tel"][maxlength]',
    'input[placeholder*="code" i]',
    'input[placeholder*="verification" i]',
    'input[placeholder*="verify" i]',
  ];

  let verifyInput = null;
  for (const sel of VERIFY_SELECTORS) {
    const el = await page.$(sel).catch(() => null);
    if (el) { verifyInput = el; break; }
  }

  if (!verifyInput) {
    // No verification input found — wait a bit more in case it's loading
    await page.waitForTimeout(5000);
    for (const sel of VERIFY_SELECTORS) {
      const el = await page.$(sel).catch(() => null);
      if (el) { verifyInput = el; break; }
    }
  }

  if (!verifyInput) {
    // Last attempt: screenshot current state for diagnosis
    await page.screenshot({
      path: path.join(__dirname, '../data/login-failure.png'),
      fullPage: true,
    }).catch(() => {});
    throw new Error(
      'Expected email verification form but found no code input. ' +
      'Check data/login-failure.png. If 163.com IMAP is not set up, ' +
      'set EMAIL_163_PASS secret (163.com 客户端授权密码).'
    );
  }

  console.log('[auth] Verification input found, fetching code from email...');
  const code = await waitForTikTokCode({ timeout: 120000 });

  await verifyInput.fill(code);

  // Submit verification (look for button near the input)
  const submitSels = [
    'button[type="submit"]',
    'button:has-text("Submit")',
    'button:has-text("Verify")',
    'button:has-text("Confirm")',
    'button:has-text("确认")',
    'button:has-text("提交")',
  ];
  for (const sel of submitSels) {
    const btn = await page.$(sel).catch(() => null);
    if (btn) { await btn.click(); break; }
  }

  // Wait for final redirect
  await page.waitForURL(url => !url.toString().includes('/login'), { timeout: 30000 });
}

function getCookieHeader(state, domain) {
  const cookies = state.cookies || [];
  return cookies
    .filter(c => domain.includes(c.domain.replace(/^\./, '')) || c.domain.includes(domain))
    .map(c => `${c.name}=${c.value}`)
    .join('; ');
}

module.exports = { ensureLoggedIn, getCookieHeader };
