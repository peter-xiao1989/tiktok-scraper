// ADX 全渠道竞品素材采集 → 工作台素材洞察入库（云端定时）
// 流程：ddddocr 自动登录 → 各赛道 watchlist 逐产品抓素材 → 按档分类 → 下载视频 → PUT 入库
import { chromium } from 'playwright';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const DIR = path.dirname(new URL(import.meta.url).pathname);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ENV = process.env;
const USER = ENV.ADX_USER, PASS = ENV.ADX_PASS;
const KEY = ENV.ADX_INGEST_KEY;
const WB = ENV.ADX_WORKBENCH || 'https://tt-ads-workbench.xiaohuipeng123.workers.dev';
const LIMIT = parseInt(ENV.ADX_LIMIT || '0');      // 每赛道限产品数（测试用，0=全部）
const PERPROD = parseInt(ENV.ADX_PERPROD || '3');  // 每产品取几条
if (!USER || !PASS || !KEY) { console.error('缺少 ADX_USER/ADX_PASS/ADX_INGEST_KEY'); process.exit(1); }

// ── 分档规则（按赛道；与工作台前端 SUBCAT_MAP 一致）────────────────────────────
const TIER = {
  prison(p) {
    const n = (p.name || '').toLowerCase(), g = p.label1 || '';
    if (g === '益智' && !/jail|prison|越狱|监狱|break/.test(n)) return ['EXCLUDE', ''];
    if (/(prison|jail|police|swat|cop|警察|监狱|crime).*(tycoon|idle|empire|inc|manage|经营|大亨|模拟器|simulator|life|corp|guard|station|department)|(tycoon|idle|empire|manager|大亨).*(prison|jail|police|监狱)|idle.*(prison|police|jail)/.test(n) || (g === '模拟' && /prison|jail|police|警察|监狱|crime|犯罪/.test(n)))
      return ['T1', `监狱/警察经营·品类=${g || '模拟'}·名含经营/tycoon`];
    if (/jail\s*break|jailbreak|prison\s*break|越狱|sneak|break\s*out|escape|逃脱|逃逸/.test(n)) return ['T2', `越狱/逃脱·品类=${g || '?'}`];
    if (/mafia|gangster|gang|黑帮|黑手党|crime|犯罪|outlaw|heist|robber|抢/.test(n)) return ['T3', `犯罪/黑帮·品类=${g || '?'}`];
    if (/police|cop|警察|patrol/.test(n)) return ['T4', `警察相关·品类=${g || '?'}`];
    return ['T4', `相关·品类=${g || '?'}`];
  },
  fps(p) {
    const n = (p.name || '').toLowerCase(), g = p.label1 || '';
    if (/bubble|泡泡|cubes?|方块消|海战棋|连连看/.test(n)) return ['EXCLUDE', ''];
    if (['益智', '消除', '桌面游戏', '棋牌'].includes(g) && !/sniper|fps|shoot|gun|狙击|射击|枪/.test(n)) return ['EXCLUDE', ''];
    if (/stickman|火柴人|pixel|像素|arcade|doodle|toy|mini/.test(n)) return ['T2', `休闲/轻度射击·品类=${g || '?'}`];
    if (/battle\s*royale|squad|team|pvp|multiplayer|吃鸡|battlegrounds|royale/.test(n)) return ['T3', `战争/吃鸡/团队·品类=${g || '?'}`];
    if (/strategy|策略|tank|坦克|naval|fleet|commander|大战略|战争策略/.test(n)) return ['T4', `战争策略/载具·品类=${g || '?'}`];
    if (/sniper|狙击|shoot|射击|射爆|gun|fps|commando|assault|counter|army|soldier|strike|hitman|combat|特种|突击|生死|枪|war\b/.test(n)) return ['T1', `军事/狙击射击·品类=${g || '?'}·名含射击/狙击/gun`];
    return ['T4', `射击相关·品类=${g || '?'}`];
  },
};
const TRACKS = [
  { theme: 'prison', file: 'watchlist-prison.json', tier: TIER.prison },
  { theme: 'fps', file: 'watchlist-fps.json', tier: TIER.fps },
];

// ── ddddocr 自动登录 ──────────────────────────────────────────────────────────
async function login(ctx) {
  const p = await ctx.newPage();
  await p.goto('https://adxray.dataeye.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2500);
  await p.fill('#accountId', USER);
  await p.fill('#password', PASS);
  try { await p.check('#isAgree', { timeout: 3000 }); } catch { try { await p.click('#isAgree'); } catch {} }
  for (let i = 1; i <= 8; i++) {
    const img = await p.$('img[src*="getVerifyCode"], img[src*="erify"], img[src*="Code"]');
    if (img) await img.screenshot({ path: '/tmp/adx-captcha.png' });
    let code = '';
    try { code = execSync('python3 ' + path.join(DIR, 'ocr.py') + ' /tmp/adx-captcha.png', { encoding: 'utf8' }).trim().replace(/[^0-9a-zA-Z]/g, ''); } catch {}
    if (code.length !== 4) { try { await img.click(); } catch {} await sleep(1200); continue; }
    await p.fill('#vCode', code);
    await p.getByRole('button', { name: /登\s*录/ }).click();
    await sleep(3000);
    const onLogin = await p.$('#accountId').then(e => !!e).catch(() => false);
    if (!onLogin) { console.log('登录成功 try' + i); await p.close(); return true; }
    try { const e = await p.$('img[src*="getVerifyCode"], img[src*="Code"]'); if (e) await e.click(); } catch {}
    await sleep(1200);
  }
  await p.close();
  throw new Error('登录失败：验证码连续 8 次未通过');
}

// ── 抓一个产品的素材 + 品类 ───────────────────────────────────────────────────
async function pullProduct(ctx, id) {
  const p = await ctx.newPage();
  let info = null, cur = [];
  p.on('response', async r => {
    const u = r.url();
    if (/getProductInfo/.test(u)) { try { info = JSON.parse(await r.text()); } catch {} }
    if (/api\/creative\/searchCreative/.test(u)) { try { const j = JSON.parse(await r.text()); for (const x of (j?.content?.searchList || [])) cur.push(x); } catch {} }
  });
  try { await p.goto(`https://oversea-v2.dataeye.com/product/${id}?type=2&isPlaylet=false`, { waitUntil: 'domcontentloaded', timeout: 40000 }); await sleep(4200); } catch {}
  await p.close();
  const byId = {}; for (const x of cur) byId[x.materialId || x.id] = x;
  return { label1: (info?.content?.label1Names || []).join('/'), creatives: Object.values(byId) };
}

async function ingestOne(ctx, x, theme, subcat, why) {
  const vurl = x.video.endsWith('.mp4') ? x.video : x.video + '.mp4';
  const vr = await ctx.request.get(vurl, { headers: { referer: 'https://oversea-v2.dataeye.com/' }, timeout: 30000 });
  if (!vr.ok()) return false;
  const buf = await vr.body(); if (buf.byteLength < 2000) return false;
  const qs = new URLSearchParams({
    key: KEY, source: 'adx', ad_id: String(x.materialId), theme, subcat, why,
    brand: x.product || '', title: x.product || '', region: (x.countries || []).map(c => c.countryName)[0] || '',
    duration: String(Math.round((x.durationMillis || 0) / 1000)), run_days: String(x.releaseDay || 0),
    reuse: String(x.relatedMaterialNum || 0), media: x.media?.mediaName || '', first_seen: x.firstSeen || '',
    cover_url: (x.picList?.[0] ? (x.picList[0].endsWith('.png') ? x.picList[0] : x.picList[0] + '.png') : ''),
    landing: x.originalUrl || '',
  });
  const ir = await fetch(`${WB}/api/inspiration/ingest?${qs}`, { method: 'PUT', body: buf });
  return (await ir.json().catch(() => ({}))).ok;
}

// ── 主流程 ────────────────────────────────────────────────────────────────────
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1500, height: 950 }, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' });
await login(ctx);
let grandOk = 0, grandFail = 0;
for (const track of TRACKS) {
  let wl = JSON.parse(fs.readFileSync(path.join(DIR, track.file), 'utf8'));
  if (LIMIT) wl = wl.slice(0, LIMIT);
  let ok = 0, fail = 0, done = 0;
  for (const prod of wl) {
    const { label1, creatives } = await pullProduct(ctx, prod.id);
    const [t, why] = track.tier({ name: prod.name, label1 });
    if (t === 'EXCLUDE') { done++; continue; }
    const cs = creatives.filter(c => (c.videoList || [])[0]).sort((a, b) => (b.releaseDay || 0) - (a.releaseDay || 0)).slice(0, PERPROD);
    for (const c of cs) {
      try { if (await ingestOne(ctx, { ...c, video: c.videoList[0], product: prod.name }, track.theme, t, why)) ok++; else fail++; }
      catch { fail++; }
    }
    done++; if (done % 20 === 0) console.log(`[${track.theme}] ${done}/${wl.length} 产品，入库成功 ${ok}`);
  }
  console.log(`[${track.theme}] 完成：成功 ${ok}，失败 ${fail}`);
  grandOk += ok; grandFail += fail;
}
await b.close();
console.log(`\n全部完成：入库成功 ${grandOk}，失败 ${grandFail}`);
if (grandOk === 0) process.exit(1);
