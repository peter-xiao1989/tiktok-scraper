const { ensureLoggedIn, getCookieHeader } = require('./auth');
const { scrapeAll } = require('./scraper');
const { appendRows, writeHeaders } = require('./feishu');
const games = require('../games.json');

const FEISHU_CONFIG = {
  appId:            process.env.FEISHU_APP_ID            || 'cli_aa898a664d395cc2',
  appSecret:        process.env.FEISHU_APP_SECRET || (() => { throw new Error('FEISHU_APP_SECRET env is required'); })(),
  spreadsheetToken: process.env.FEISHU_SPREADSHEET_TOKEN  || 'QGOws5DHvhz8hqtzfMQc51oenId',
  sheetId:          process.env.FEISHU_SHEET_ID           || '0ac8d8',
};

function dateRange(start, end) {
  const dates = [];
  const cur = new Date(start);
  const last = new Date(end);
  while (cur <= last) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

function getLastNDays(n) {
  const end = new Date();
  end.setDate(end.getDate() - 1);
  const start = new Date(end);
  start.setDate(start.getDate() - (n - 1));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

async function main() {
  const days = parseInt(process.env.DAYS || '7', 10);
  const { start, end } = process.env.START_DATE && process.env.END_DATE
    ? { start: process.env.START_DATE, end: process.env.END_DATE }
    : getLastNDays(days);

  const dates = dateRange(start, end);
  console.log(`\nFeishu export: ${start} → ${end} (${dates.length} days × ${games.length} games)`);

  const authState = await ensureLoggedIn();
  const portalCookies = getCookieHeader(authState, 'developers.tiktok.com');
  const dataCookies = getCookieHeader(authState, 'developers.us.tiktok.com');

  console.log('\nUpdating sheet headers...');
  const hRes = await writeHeaders(FEISHU_CONFIG);
  if (hRes.code !== 0) {
    console.error('Header write failed:', JSON.stringify(hRes));
    process.exit(1);
  }
  console.log('Headers OK');

  let totalRows = 0;
  for (const date of dates) {
    process.stdout.write(`\n[${date}] scraping... `);
    const results = await scrapeAll(games, date, portalCookies, dataCookies);
    const rows = results.filter(r => r.ok).map(r => r.row);
    const failed = results.filter(r => !r.ok);
    process.stdout.write(`${rows.length} rows. Writing to Feishu... `);

    if (rows.length > 0) {
      const res = await appendRows(rows, FEISHU_CONFIG);
      if (res.code !== 0) {
        console.error(`\nFeishu write failed for ${date}:`, JSON.stringify(res));
        process.exit(1);
      }
      process.stdout.write('OK');
    }
    if (failed.length) process.stdout.write(` (${failed.length} failed: ${failed.map(f => f.game).join(', ')})`);
    totalRows += rows.length;

    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\n\nDone. Total ${totalRows} rows written.`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
