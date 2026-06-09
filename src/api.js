const https = require('https');

const PORTAL_BASE = 'https://developers.tiktok.com';
const DATA_BASE = 'https://developers.us.tiktok.com';

function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

async function getClientKey(gameId, cookieHeader) {
  const url = `${PORTAL_BASE}/tiktok/v4/devportal/mini_game/basic_info?mini_game_id=${gameId}`;
  const res = await httpGet(url, {
    Cookie: cookieHeader,
    Referer: PORTAL_BASE,
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  });
  if (res.status !== 200 || !res.body.client_key) {
    throw new Error(`Failed to get client_key for game ${gameId}: ${res.status}`);
  }
  return res.body.client_key;
}

async function fetchAnalytics(endpoint, clientKey, date, cookieHeader, extraParams = '') {
  const url = `${DATA_BASE}/tiktok/v1/data_orchestor/minigame/analytics/${endpoint}?client_key=${clientKey}&start_time=${date}&end_time=${date}${extraParams}`;
  const res = await httpGet(url, {
    Cookie: cookieHeader,
    Referer: PORTAL_BASE,
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  });
  if (res.status !== 200) {
    throw new Error(`API ${endpoint} returned ${res.status}`);
  }
  return res.body;
}

async function fetchAllGameData(gameId, clientKey, date, cookieHeader) {
  const [behavior, performance, retention, iaa, adsOverview, adsFirstDay, adsHistory] = await Promise.all([
    fetchAnalytics('user_behavior', clientKey, date, cookieHeader),
    fetchAnalytics('performance', clientKey, date, cookieHeader),
    fetchAnalytics('user_retention', clientKey, date, cookieHeader),
    fetchAnalytics('iaa', clientKey, date, cookieHeader, '&ad_type=1'),
    fetchAnalytics('ads_overview', clientKey, date, cookieHeader).catch(() => ({})),
    fetchAnalytics('first_day_activation', clientKey, date, cookieHeader).catch(() => ({})),
    fetchAnalytics('history_activation', clientKey, date, cookieHeader).catch(() => ({})),
  ]);
  return { behavior, performance, retention, iaa, adsOverview, adsFirstDay, adsHistory };
}

module.exports = { getClientKey, fetchAllGameData };
