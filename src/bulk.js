const { ensureLoggedIn, getCookieHeader } = require('./auth');
const { scrapeAll } = require('./scraper');
const games = require('../games.json');
const fs = require('fs');
const path = require('path');

const CSV_FILE = path.join(__dirname, '../data/output-full.csv');

const HEADERS = [
  '游戏名称','统计周期','新增用户','活跃用户','新增激活率',
  '总启动次数','人均进入次数','每位用户平均时长_分','次均游戏时长_分',
  '平均启动速度_秒','平均首次启动速度_秒','次留',
  '广告曝光量','广告点击量','广告点击率','eCPM','人均广告展示次数','广告总收入','ROI',
];

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

function rowToCsv(row) {
  return HEADERS.map(h => {
    const v = String(row[h] ?? '');
    return v.includes(',') ? `"${v}"` : v;
  }).join(',');
}

async function main() {
  const START = process.env.START_DATE || '2026-04-01';
  const END = process.env.END_DATE || (() => {
    const d = new Date(); d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  })();

  const dates = dateRange(START, END);
  console.log(`\nBulk scrape: ${START} → ${END} (${dates.length} days × ${games.length} games = ${dates.length * games.length} rows)\n`);

  const authState = await ensureLoggedIn();
  const portalCookies = getCookieHeader(authState, 'developers.tiktok.com');
  const dataCookies = getCookieHeader(authState, 'developers.us.tiktok.com');

  // Write header
  fs.mkdirSync(path.dirname(CSV_FILE), { recursive: true });
  fs.writeFileSync(CSV_FILE, HEADERS.join(',') + '\n', 'utf8');

  let total = 0;
  for (const date of dates) {
    process.stdout.write(`${date} ... `);
    const results = await scrapeAll(games, date, portalCookies, dataCookies);
    const rows = results.filter(r => r.ok).map(r => r.row);
    const lines = rows.map(rowToCsv).join('\n') + '\n';
    fs.appendFileSync(CSV_FILE, lines, 'utf8');
    total += rows.length;
    const failed = results.filter(r => !r.ok).length;
    console.log(`${rows.length} OK${failed ? `, ${failed} failed` : ''}`);
    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\nDone. Total rows: ${total} → ${CSV_FILE}`);
}

main().catch(e => { console.error(e); process.exit(1); });
