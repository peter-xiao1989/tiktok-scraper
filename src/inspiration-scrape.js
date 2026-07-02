/**
 * 素材洞察采集：从 TikTok 创意中心 Top Ads 抓取市场优质广告素材，
 * 下载 mp4 并按主题入库到投放工作台（/api/inspiration/ingest）。
 *
 * 机制：匿名态关键词搜索被锁(40101)、URL 行业过滤不稳，但 Top Ads 列表
 * (period×region×order_by×page) 完全开放且自带可下载 mp4。本脚本广采多个
 * region/period/order/page 的 Top Ads，按标题关键词归类到游戏题材，下载入库。
 *
 * env: WB_INGEST_URL（工作台 https://.../api/inspiration/ingest）、WB_SETUP_KEY
 *      INSP_REGIONS（默认 US,JP,BR）、INSP_PERIODS（默认 7,30）、INSP_PAGES（默认 3）
 */
const { chromium } = require('playwright');
const https = require('https');

const INGEST = process.env.WB_INGEST_URL;
const KEY = process.env.WB_SETUP_KEY;
const REGIONS = (process.env.INSP_REGIONS || 'US,JP,BR').split(',');
const PERIODS = (process.env.INSP_PERIODS || '7,30').split(',');
const PAGES = parseInt(process.env.INSP_PAGES || '3', 10);
const ORDERS = ['for_you', 'ctr', 'like'];

// 题材关键词 → theme（标题/品牌命中即归类；命中多个取第一个）
const THEMES = [
  ['fps', /\b(shooter|shooting|fps|sniper|gunfight|gunfire|combat|battle|warfare|frontline|soldier)\b|射击|狙击|枪战/i],
  ['prison', /\b(prison|jail|inmate|escape|breakout)\b|监狱|越狱/i],
  ['mafia', /\b(mafia|gangster|godfather|underworld)\b|黑帮|帮派/i],
  ['merge', /\b(merge|merging)\b.*\b(game|puzzle|defense|tower)\b|合成.*(塔防|游戏)/i],
  ['sim', /\b(tycoon|idle game|simulator game|build your empire|management game)\b|模拟经营|养成游戏/i],
  ['snake', /\b(snake|slither)\b.*\b(game|io)\b|贪吃蛇/i],
  ['pizza', /\b(restaurant|cooking|chef)\b.*\b(game|tycoon)\b|餐厅经营|做饭游戏/i],
  ['casual', /\b(mini game|mobile game|play now.*game|hypercasual|hyper-casual|puzzle game|tower defense)\b|小游戏|休闲游戏/i],
];
function classify(title, brand) {
  const t = `${title} ${brand}`;
  for (const [name, re] of THEMES) if (re.test(t)) return name;
  return null;   // 只保留明确游戏题材，宁缺毋滥
}

function download(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://ads.tiktok.com/' } }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('http ' + res.statusCode)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

function ingest(meta, buf) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams({ key: KEY, ...meta }).toString();
    const u = new URL(INGEST + '?' + qs);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'PUT',
      headers: { 'Content-Type': 'video/mp4', 'Content-Length': buf.length } },
      res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.write(buf); req.end();
  });
}

async function main() {
  if (!INGEST || !KEY) throw new Error('需要 WB_INGEST_URL 和 WB_SETUP_KEY');
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
    locale: 'en-US', viewport: { width: 1440, height: 900 },
  });
  const page = await ctx.newPage();

  const seen = new Set();
  let pending = [];
  page.on('response', async res => {
    const u = res.url();
    if (u.includes('/top_ads/v2/list')) {
      try { const j = await res.json(); const arr = j.data?.materials || j.data?.list || []; pending.push(...arr); } catch {}
    }
  });

  let harvested = 0, stored = 0;
  for (const region of REGIONS) {
    for (const period of PERIODS) {
      for (const order of ORDERS) {
        for (let pg = 1; pg <= PAGES; pg++) {
          pending = [];
          const url = `https://ads.tiktok.com/business/creativecenter/inspiration/topads/pad/en?period=${period}&region=${region}&order_by=${order}&page=${pg}`;
          await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
          await page.waitForTimeout(3500 + pg * 800);
          const ads = pending.splice(0);
          harvested += ads.length;
          for (const ad of ads) {
            const id = ad.id;
            if (!id || seen.has(id)) continue;
            seen.add(id);
            const theme = classify(ad.ad_title || '', ad.brand_name || '');
            if (!theme) continue;   // 非游戏题材丢弃
            const vi = ad.video_info || {};
            const vurl = vi.video_url?.['720p'] || vi.video_url?.['540p'] || vi.video_url?.['480p'] || vi.video_url?.['360p'];
            if (!vurl) continue;
            try {
              const buf = await download(vurl);
              if (buf.length < 10000) continue;
              await ingest({
                source: 'tiktok_cc', ad_id: id, title: (ad.ad_title || '').slice(0, 180),
                brand: ad.brand_name || '', theme, region,
                ctr: ad.ctr ?? 0, likes: ad.like ?? 0, cost: ad.cost ?? 0,
                duration: vi.duration ?? 0, width: vi.width ?? 0, height: vi.height ?? 0,
                cover_url: vi.cover || '',
                landing: `https://ads.tiktok.com/business/creativecenter/inspiration/topads/pad/en?id=${id}`,
              }, buf);
              stored++;
              process.stdout.write(`\r  ${region}/${period}/${order} p${pg} — 入库 ${stored}（采集 ${harvested}）`);
            } catch (e) { /* 单条失败跳过 */ }
          }
        }
      }
    }
  }
  process.stdout.write('\n');
  console.log(`完成：采集 ${harvested}，去重题材入库 ${stored}`);
  await browser.close();
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
