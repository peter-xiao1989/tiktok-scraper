const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '../data/auth-state.json');
const EMAIL = process.env.TIKTOK_EMAIL || 'a3699251@163.com';
const PASSWORD = process.env.TIKTOK_PASSWORD || 'Xhp3699251$';
const BASE = 'https://developers.tiktok.com';

async function ensureLoggedIn() {
  if (fs.existsSync(STATE_FILE)) {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const cookies = state.cookies || [];
    // Check if session cookie still exists and is not expired
    const sessionCookie = cookies.find(c => c.name === 'sid_guard_tt_open' || c.name === 'sessionid');
    if (sessionCookie) {
      const expiresAt = sessionCookie.expires * 1000;
      if (expiresAt > Date.now()) {
        console.log('[auth] Using cached session');
        return state;
      }
    }
  }

  console.log('[auth] Logging in via browser...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  await page.goto(`${BASE}/login`, { waitUntil: 'load', timeout: 30000 });
  await page.locator('input[placeholder="Email"]').click();
  await page.locator('input[placeholder="Email"]').pressSequentially(EMAIL, { delay: 40 });
  await page.locator('input[placeholder="Password"]').click();
  await page.locator('input[placeholder="Password"]').pressSequentially(PASSWORD, { delay: 40 });
  await page.waitForFunction(
    () => !document.querySelector('button[type="submit"]')?.disabled,
    { timeout: 10000 }
  );
  await page.locator('button:has-text("Log in")').click();
  await page.waitForURL(url => !url.toString().includes('/login'), { timeout: 30000 });

  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  await context.storageState({ path: STATE_FILE });
  await browser.close();

  console.log('[auth] Login successful, session saved');
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
}

function getCookieHeader(state, domain) {
  const cookies = state.cookies || [];
  return cookies
    .filter(c => domain.includes(c.domain.replace(/^\./, '')) || c.domain.includes(domain))
    .map(c => `${c.name}=${c.value}`)
    .join('; ');
}

module.exports = { ensureLoggedIn, getCookieHeader };
