const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ADS_STATE_FILE = path.join(__dirname, '../data/ads-auth-state.json');
const REPORT_URL = 'https://business.tiktok.com/manage/custom_reports/list?reportId=7649006117921488904&org_id=7623379731659948049';
const EMAIL = process.env.ADS_EMAIL || 'peter@kuaiql.com';
const PASSWORD = process.env.ADS_PASSWORD || 'Xhp3699251';

async function main() {
  const browser = await chromium.launch({ headless: false });

  let context;
  if (fs.existsSync(ADS_STATE_FILE)) {
    console.log('[ads-probe] Loading cached session...');
    context = await browser.newContext({
      storageState: ADS_STATE_FILE,
      viewport: { width: 1440, height: 900 },
    });
  } else {
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  }

  const captured = [];
  context.on('response', async res => {
    const url = res.url();
    if (url.includes('business-api.tiktok.com') || url.includes('ads.tiktok.com/open_api') ||
        url.includes('/custom_report') || url.includes('/report/')) {
      try {
        const body = await res.json().catch(() => null);
        if (body) {
          captured.push({ url, status: res.status(), body });
          console.log('[captured]', url, res.status());
        }
      } catch {}
    }
  });

  const page = await context.newPage();
  console.log(`\nOpening: ${REPORT_URL}`);
  await page.goto(REPORT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});

  // Wait up to 60s for login redirect (auth check is async, happens ~20-30s after load)
  console.log('Waiting for auth check (up to 60s)...');
  const loginOccurred = await page.waitForURL(
    url => url.toString().includes('/login'),
    { timeout: 60000 }
  ).then(() => true).catch(() => false);

  if (loginOccurred) {
    console.log('[auth] Login page, URL:', page.url());
    console.log('[auth] Filling credentials...');
    await page.waitForSelector('input[type="password"]', { timeout: 15000 });
    await page.locator('input[type="email"], input[placeholder*="Email"]').first().fill(EMAIL);
    await page.waitForTimeout(400);
    await page.locator('input[type="password"]').first().fill(PASSWORD);
    await page.waitForTimeout(400);
    await page.locator('button:has-text("Log in")').first().click();
    console.log('[auth] Submitted, waiting for redirect back...');
    await page.waitForTimeout(5000);
    await page.screenshot({ path: path.join(__dirname, '../data/ads-after-login.png') });
    console.log('[auth] Screenshot saved: data/ads-after-login.png, URL:', page.url());
    await page.waitForURL(
      url => url.toString().includes('business.tiktok.com/manage'),
      { timeout: 60000 }
    );
    console.log('[auth] Back on manage, URL:', page.url());
  } else {
    console.log('No login redirect — session still valid, URL:', page.url());
  }

  console.log('\nWaiting 20s for report data to load...');
  await page.waitForTimeout(20000);

  // Save session
  fs.mkdirSync(path.dirname(ADS_STATE_FILE), { recursive: true });
  await context.storageState({ path: ADS_STATE_FILE });
  console.log(`[ads-probe] Session saved to ${ADS_STATE_FILE}`);

  // Save captured requests
  const outFile = path.join(__dirname, '../data/ads-probe-results.json');
  fs.writeFileSync(outFile, JSON.stringify(captured, null, 2));
  console.log(`\nCaptured ${captured.length} API responses → ${outFile}`);

  if (captured.length > 0) {
    console.log('\n=== Captured URLs ===');
    captured.forEach(c => console.log(' ', c.url));
  } else {
    console.log('\nNo API calls captured. Check if the page loaded correctly.');
    console.log('Current URL:', page.url());
    await page.screenshot({ path: path.join(__dirname, '../data/ads-probe-screenshot.png') });
    console.log('Screenshot saved to data/ads-probe-screenshot.png');
  }

  await browser.close();
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
