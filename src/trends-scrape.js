/**
 * 内容热榜采集：TikTok 创意中心 Top Ads 爆款创意，按地区抓 Top N，入库投放工作台「内容热榜」。
 * 数据匿名可取（真浏览器拦截 /top_ads/v2/list 签名 XHR）。hashtag/song 趋势需登录，暂不在此。
 *
 * 双模式：
 *   - 设了 WB_BASE + WB_SETUP_KEY → POST {WB_BASE}/api/trends/ingest（GitHub Actions 每日用）
 *   - 否则 → 写 JSON 到 TRENDS_OUT（默认 /tmp/trends.json），本地 wrangler 灌库用
 *
 * env: TR_REGIONS(默认 US,GB,DE,FR)、TR_PERIOD(默认 7)、TR_TOPN(默认 60)、WB_BASE、WB_SETUP_KEY、TRENDS_OUT
 */
const { chromium } = require('playwright');
const fs = require('fs');
const https = require('https');

const REGIONS = (process.env.TR_REGIONS || 'US,GB,DE,FR').split(',').map(s => s.trim()).filter(Boolean);
const PERIODS = (process.env.TR_PERIODS || '7,30').split(',').map(s => s.trim()).filter(Boolean);
const ORDERS = (process.env.TR_ORDERS || 'for_you,ctr,like').split(',').map(s => s.trim()).filter(Boolean);
const TOPN = parseInt(process.env.TR_TOPN || '500', 10);
const WB_BASE = process.env.WB_BASE;
const KEY = process.env.WB_SETUP_KEY;
const OUT = process.env.TRENDS_OUT || '/tmp/trends.json';

// 北京日历日
const bjDate = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

function postIngest(payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const u = new URL(`${WB_BASE}/api/trends/ingest?key=${encodeURIComponent(KEY)}`);
    const req = https.request(u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
      let b = ''; res.on('data', d => b += d); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

// 行业 code→名 映射（扁平化 filters 的 industry 树）
function flattenIndustry(list, out) {
  for (const it of (list || [])) {
    if (it.value && it.label) out[it.value] = it.label;
    if (it.children) flattenIndustry(it.children, out);
  }
}

// 抓一个 (region, period)：遍历多个 order_by（每个是一份不同的 Top 20），合并去重。
// 匿名态每个榜单硬上限 20（View More 需登录），靠多 order 排列组合扩面。rank 以 for_you 序为准、其余追加。
async function scrapeRegionPeriod(page, region, period, industryMap) {
  let pending = [];
  const handler = async res => {
    const u = res.url();
    if (u.includes('/top_ads/v2/filters')) {
      try { const j = await res.json(); flattenIndustry(j.data?.industry, industryMap); } catch {}
      return;
    }
    if (!u.includes('/top_ads/v2/list')) return;
    try { const j = await res.json(); pending.push(...(j.data?.materials || j.data?.list || [])); } catch {}
  };
  page.on('response', handler);

  const seen = new Set(); const items = [];
  for (const order of ORDERS) {
    pending = [];
    const url = `https://ads.tiktok.com/business/creativecenter/inspiration/topads/pad/en?period=${period}&region=${region}&order_by=${order}&page=1`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(4500);
    for (const ad of pending) {
      const id = String(ad.id || '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const vi = ad.video_info || {};
      const vurl = vi.video_url?.['720p'] || vi.video_url?.['540p'] || vi.video_url?.['480p'] || vi.video_url?.['360p'] || '';
      items.push({
        ext_id: id, rank: items.length + 1,
        title: ad.ad_title || '', brand: ad.brand_name || '', industry: industryMap[ad.industry_key] || ad.industry_key || '',
        ctr: ad.ctr ?? null, likes: ad.like ?? null, cost: ad.cost ?? null,
        duration: vi.duration ?? null, width: vi.width ?? null, height: vi.height ?? null,
        cover_url: vi.cover || '', video_url: vurl,
        landing: `https://ads.tiktok.com/business/creativecenter/inspiration/topads/pad/en?id=${id}`,
      });
      if (items.length >= TOPN) break;
    }
    if (items.length >= TOPN) break;
  }
  page.off('response', handler);
  return items;
}

(async () => {
  const snap_date = bjDate();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
    locale: 'en-US', viewport: { width: 1440, height: 900 },
  });
  const page = await ctx.newPage();
  const industryMap = {};
  const all = [];
  for (const region of REGIONS) {
    for (const period of PERIODS) {
      process.stdout.write(`抓取 ${region}/period=${period} …`);
      let items = [];
      try { items = await scrapeRegionPeriod(page, region, period, industryMap); } catch (e) { console.log(' 失败', e.message); }
      console.log(` ${items.length} 条`);
      const payload = { snap_date, type: 'topad', region, period, items };
      if (WB_BASE && KEY) {
        try { const r = await postIngest(payload); console.log(`  → 入库 ${r.status} ${r.body.slice(0, 100)}`); }
        catch (e) { console.log('  → 入库失败', e.message); }
      }
      all.push(payload);
    }
  }
  await browser.close();
  if (!(WB_BASE && KEY)) { fs.writeFileSync(OUT, JSON.stringify(all)); console.log(`已写 ${OUT}（${all.reduce((s, p) => s + p.items.length, 0)} 条），用 wrangler 灌库`); }
  console.log('完成', snap_date);
})();
