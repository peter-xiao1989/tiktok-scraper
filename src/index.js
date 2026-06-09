const { ensureLoggedIn, getCookieHeader } = require('./auth');
const { scrapeAll } = require('./scraper');
const { appendRecords, initBitable } = require('./bitable');
const { loadGames } = require('./games-loader');

const FEISHU_CONFIG = {
  appId:    process.env.FEISHU_APP_ID     || 'cli_aa898a664d395cc2',
  appSecret: process.env.FEISHU_APP_SECRET || 'fOlixcmQNWlOBkrEAHagGdZUI5Fum3KX',
};

function getYesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const date = process.env.TARGET_DATE || getYesterday();

  const games = await loadGames(FEISHU_CONFIG.appId, FEISHU_CONFIG.appSecret);
  console.log(`\nTikTok scraper — date: ${date}, games: ${games.length}`);

  const authState = await ensureLoggedIn();
  const portalCookies = getCookieHeader(authState, 'developers.tiktok.com');
  const dataCookies = getCookieHeader(authState, 'developers.us.tiktok.com');

  console.log('Scraping...');
  const results = await scrapeAll(games, date, portalCookies, dataCookies);

  const successRows = results.filter(r => r.ok).map(r => r.row);
  const failedGames = results.filter(r => !r.ok);

  if (successRows.length > 0) {
    console.log(`\nWriting ${successRows.length} rows to Bitable...`);
    await appendRecords(successRows, FEISHU_CONFIG);
    console.log('Bitable write OK');
  }

  if (failedGames.length > 0) {
    console.error(`\nFailed (${failedGames.length}): ${failedGames.map(f => f.game).join(', ')}`);
    if (successRows.length === 0) process.exit(1);
  }

  console.log('Done.');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
