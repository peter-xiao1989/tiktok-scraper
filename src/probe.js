const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = 'https://developers.tiktok.com';
const STATE_FILE = path.join(__dirname, '../data/auth-state.json');
const OUT = path.join(__dirname, '../data/screenshots');
const GAME_ID = '7636617788911618066'; // Sniper Action

function isDataApi(url) {
  return url.includes('data_orchestor') || url.includes('analytics') || url.includes('monetization') || url.includes('iaa') || url.includes('retention') || url.includes('performance') || url.includes('revenue');
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch({ headless: false, slowMo: 200 });
  const stateOpts = fs.existsSync(STATE_FILE) ? { storageState: STATE_FILE } : {};
  const context = await browser.newContext({ ...stateOpts, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  const apiLog = [];
  page.on('response', async (res) => {
    const ct = res.headers()['content-type'] || '';
    if (!ct.includes('json')) return;
    try {
      const body = await res.json();
      const url = res.url();
      if (isDataApi(url)) {
        apiLog.push({ url, body });
        console.log('[API]', url.split('?')[0]);
      }
    } catch {}
  });

  // Login if needed
  await page.goto(`${BASE}/portal`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(2000);
  if (page.url().includes('/login')) {
    console.log('Logging in...');
    await page.goto(`${BASE}/login`, { waitUntil: 'load' });
    await page.locator('input[placeholder="Email"]').fill('a3699251@163.com');
    await page.locator('input[placeholder="Password"]').fill('Xhp3699251$');
    await page.locator('button:has-text("Log in")').click();
    await page.waitForURL(url => !url.toString().includes('/login'), { timeout: 15000 });
    await context.storageState({ path: STATE_FILE });
    console.log('Logged in and session saved.');
  }

  // Load data-dashboard and wait for content
  console.log('Loading data-dashboard (用户>行为)...');
  await page.goto(`${BASE}/portal/game/${GAME_ID}/data-dashboard`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(12000); // give SPA time to load data
  await page.screenshot({ path: `${OUT}/tab-behavior.png` });

  // Click 留存率 subtab
  console.log('\nClicking 留存率 tab...');
  try {
    await page.locator('text=留存率').first().click({ timeout: 10000 });
    await page.waitForTimeout(5000);
    await page.screenshot({ path: `${OUT}/tab-retention.png` });
  } catch (e) { console.log('留存率 tab not found:', e.message.slice(0, 80)); }

  // Click 表现 top-level tab
  console.log('\nClicking 表现 tab...');
  try {
    // The 表现 tab is a top-level tab (not a subtab under 用户)
    const tabs = await page.locator('[role="tab"]').all();
    console.log('All tabs:', await Promise.all(tabs.map(t => t.innerText().catch(() => ''))));
    await page.locator('[role="tab"]:has-text("表现")').first().click({ timeout: 10000 });
    await page.waitForTimeout(5000);
    await page.screenshot({ path: `${OUT}/tab-performance.png` });
  } catch (e) {
    console.log('表现 tab not found via role, trying text...');
    try {
      await page.getByText('表现', { exact: true }).first().click({ timeout: 5000 });
      await page.waitForTimeout(5000);
      await page.screenshot({ path: `${OUT}/tab-performance.png` });
    } catch (e2) { console.log('Also failed:', e2.message.slice(0, 80)); }
  }

  // Load monetization page
  console.log('\nLoading monetization (IAA)...');
  await page.goto(`${BASE}/portal/game/${GAME_ID}/monetization?tab=iaa`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(12000);
  await page.screenshot({ path: `${OUT}/tab-monetization.png` });

  // Save all captured data APIs
  fs.writeFileSync(`${OUT}/data-apis.json`, JSON.stringify(apiLog, null, 2));
  console.log(`\nTotal data API calls captured: ${apiLog.length}`);
  apiLog.forEach(a => {
    console.log('\nURL:', a.url);
    console.log('Keys:', Object.keys(a.body));
  });

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
