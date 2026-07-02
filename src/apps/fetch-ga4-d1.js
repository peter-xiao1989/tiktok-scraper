#!/usr/bin/env node
// APP 线:GA4 Data API → KQL 经分后台 D1(app_daily)。与 fetch-ga4.js(写飞书)并行,数据源相同。
// 按 项目×平台×国家×日 拉取 + 属性级 cohort 留存。POST 到 /api/ingest/app(EXPORT_TOKEN 鉴权)。
// 认证:服务账号 JSON(env GA4_SA_JSON)→ JWT RS256 → access token。复用 fetch-ga4 同一服务账号。
const https = require('https');
const crypto = require('crypto');

const PROPERTIES = [
  { app: '麻将', platform: 'iOS', property: '531751891' },
  { app: '麻将', platform: 'Android', property: '539961183' },
  { app: '积木', platform: 'iOS', property: '539468626' },
  { app: '积木', platform: 'Android', property: '539517442' },
];
const DAYS = parseInt(process.env.GA4_D1_DAYS || '180', 10);
const ANALYTICS_URL = (process.env.ANALYTICS_URL || 'https://tiktok-analytics.xiaohuipeng123.workers.dev').replace(/\/$/, '');
const TOKEN = process.env.EXPORT_TOKEN || (() => { throw new Error('EXPORT_TOKEN required'); })();
const SA = JSON.parse(process.env.GA4_SA_JSON || (() => { throw new Error('GA4_SA_JSON required'); })());

function req(host, method, path, headers, body) {
  return new Promise((res, rej) => {
    const r = https.request({ hostname: host, path, method, headers, timeout: 60000 }, rs => {
      const c = []; rs.on('data', x => c.push(x));
      rs.on('end', () => { try { res(JSON.parse(Buffer.concat(c).toString('utf8'))); } catch (e) { rej(new Error('non-JSON: ' + Buffer.concat(c).toString().slice(0, 150))); } });
    });
    r.on('timeout', () => { r.destroy(); rej(new Error('timeout')); }); r.on('error', rej);
    if (body) r.write(body); r.end();
  });
}
async function googleToken() {
  const now = Math.floor(Date.now() / 1000);
  const enc = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = enc({ alg: 'RS256', typ: 'JWT' }) + '.' + enc({
    iss: SA.client_email, scope: 'https://www.googleapis.com/auth/analytics.readonly',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  });
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(SA.private_key).toString('base64url');
  const body = `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${unsigned}.${sig}`;
  const r = await req('oauth2.googleapis.com', 'POST', '/token', { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }, body);
  if (!r.access_token) throw new Error('google auth failed: ' + JSON.stringify(r).slice(0, 200));
  return r.access_token;
}
let GTOK = '';
async function ga4(property, payload) {
  const body = JSON.stringify(payload);
  for (let a = 0; ; a++) {
    const r = await req('analyticsdata.googleapis.com', 'POST', `/v1beta/properties/${property}:runReport`,
      { Authorization: 'Bearer ' + GTOK, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, body)
      .catch(e => ({ error: { message: e.message, transient: true } }));
    if (!r.error) return r;
    if (a < 4 && (r.error.transient || r.error.code === 429 || r.error.code >= 500)) { await new Promise(s => setTimeout(s, 3000 * (a + 1))); continue; }
    throw new Error(`GA4 ${property}: ${r.error.message}`);
  }
}
const isoOf = d8 => `${d8.slice(0, 4)}-${d8.slice(4, 6)}-${d8.slice(6, 8)}`;
const r4 = v => Math.round(v * 10000) / 10000;
const r2 = v => Math.round(v * 100) / 100;

// 按 日期×国家 拉每日指标
async function fetchByCountry(p) {
  const r = await ga4(p.property, {
    dateRanges: [{ startDate: `${DAYS}daysAgo`, endDate: 'yesterday' }],
    dimensions: [{ name: 'date' }, { name: 'countryId' }],
    metrics: ['activeUsers', 'newUsers', 'sessions', 'userEngagementDuration', 'averageSessionDuration', 'totalAdRevenue', 'totalRevenue'].map(m => ({ name: m })),
    limit: 200000,
  });
  const out = [];
  for (const row of r.rows || []) {
    const d = row.dimensionValues[0].value, country = (row.dimensionValues[1].value || 'US').toUpperCase();
    if (!/^\d{8}$/.test(d)) continue;
    const [au, nu, se, dur, asd, adRev, totRev] = row.metricValues.map(v => parseFloat(v.value) || 0);
    if (au || nu || adRev || totRev) out.push({ d, country, au, nu, se, dur, asd, adRev, totRev });
  }
  return out;
}
// 属性级 cohort 留存(次/7/30 留),按 firstSessionDate 分组
async function fetchRetention(p, dates) {
  const ret = {};
  for (let i = 0; i < dates.length; i += 12) {
    const chunk = dates.slice(i, i + 12);
    const r = await ga4(p.property, {
      dimensions: [{ name: 'cohort' }, { name: 'cohortNthDay' }], metrics: [{ name: 'cohortActiveUsers' }],
      cohortSpec: { cohorts: chunk.map(d => ({ name: d, dimension: 'firstSessionDate', dateRange: { startDate: isoOf(d), endDate: isoOf(d) } })), cohortsRange: { granularity: 'DAILY', startOffset: 0, endOffset: 30 } },
      limit: 5000,
    });
    const grid = {};
    for (const row of r.rows || []) { const [c, nth] = row.dimensionValues.map(v => v.value); (grid[c] = grid[c] || {})[parseInt(nth, 10)] = parseFloat(row.metricValues[0].value) || 0; }
    for (const [d, g] of Object.entries(grid)) { const base = g[0] || 0; if (!base) continue; ret[d] = { d1: g[1] != null ? r4(g[1] / base) : 0, d7: g[7] != null ? r4(g[7] / base) : 0, d30: g[30] != null ? r4(g[30] / base) : 0 }; }
  }
  return ret;
}

// 事件埋点:日期×事件 → 触发用户/次数
async function fetchEvents(p) {
  const r = await ga4(p.property, {
    dateRanges: [{ startDate: `${DAYS}daysAgo`, endDate: 'yesterday' }],
    dimensions: [{ name: 'date' }, { name: 'eventName' }],
    metrics: [{ name: 'eventCount' }, { name: 'activeUsers' }],
    limit: 200000,
  });
  const out = [];
  for (const row of r.rows || []) {
    const d = row.dimensionValues[0].value, ev = row.dimensionValues[1].value;
    if (!/^\d{8}$/.test(d) || !ev) continue;
    const [cnt, users] = row.metricValues.map(v => parseFloat(v.value) || 0);
    out.push({ d, ev, cnt, users });
  }
  return out;
}
// 激活漏斗:只用"每新用户仅 1 次"的引导事件——窗口内按日去重用户累加=区间新用户数,漏斗才单调可信。
// 每次进关(level_enter)/每次曝光(ad_impression)会重复触发,累加会灌成几倍,绝不能放进激活漏斗。
// 两款游戏埋点体系不同,按游戏各建(积木用 tutorial_*,麻将用 guide_*)。
const ACTIVATION = {
  // 注:完成引导只取规范事件 tutorial_complete(tutorial_finish 是重复埋点,混用会经 per-day max 虚高)
  // tutorial_step_1 漏报(实测 <tutorial_complete),不可靠,已剔除
  '积木': [
    { key: 'first_open', name: '首次打开', cands: ['first_open'] },
    { key: 'load_finish', name: '加载完成(新用户)', cands: ['cold_launch_finish', 'loading_complete'] },
    { key: 'guide_enter', name: '进入新手引导', cands: ['tutorial_start', 'show_tutorial_intro', 'tutorial_level_enter'] },
    { key: 'guide_finish', name: '完成新手引导', cands: ['tutorial_complete'] },
  ],
  '麻将': [
    { key: 'first_open', name: '首次打开', cands: ['first_open'] },
    { key: 'guide_enter', name: '进入新手引导', cands: ['guide_level_enter'] },
    { key: 'guide_step1', name: '完成引导第1步', cands: ['guide_step_1_complete'] },
    { key: 'guide_step3', name: '完成引导第3步', cands: ['guide_step_3_complete'] },
    { key: 'guide_finish', name: '完成新手引导', cands: ['guide_all_finish'] },
  ],
};
// 激励广告漏斗:发起→发奖(发放率=reward/show=IAA 变现健康度)。step_order 20+ 与激活漏斗区分。
// 注:两款游戏"完播"埋点(ad_reward_show_success/ad_reward_finish)均漏报不可靠,已剔除,只保留发起/发奖。
const AD_FUNNEL = {
  '积木': [
    { key: 'adf_show', name: '激励广告发起', cands: ['ad_reward_show', 'ad_reward_show_start'] },
    { key: 'adf_reward', name: '发放奖励', cands: ['ad_reward', 'ad_reward_reward'] },
  ],
  '麻将': [
    { key: 'adf_show', name: '激励广告发起', cands: ['ad_reward_show_start'] },
    { key: 'adf_reward', name: '发放奖励', cands: ['ad_reward_reward'] },
  ],
};
// 关卡进阶:level_enter_N_* = 到达 / level_success_N_* = 通关(各关 unique 用户,窗口期)
async function fetchLevels(p) {
  const r = await ga4(p.property, {
    dateRanges: [{ startDate: `${DAYS}daysAgo`, endDate: 'yesterday' }],
    dimensions: [{ name: 'eventName' }], metrics: [{ name: 'activeUsers' }], limit: 5000,
  });
  const reached = {}, done = {};
  for (const row of r.rows || []) {
    const ev = row.dimensionValues[0].value, u = parseFloat(row.metricValues[0].value) || 0;
    let m = /^level_enter_(\d+)/.exec(ev); if (m) { reached[+m[1]] = (reached[+m[1]] || 0) + u; continue; }
    m = /^level_success_(\d+)/.exec(ev); if (m) done[+m[1]] = (done[+m[1]] || 0) + u;
  }
  const out = [];
  for (const n of Object.keys(reached).map(Number).sort((a, b) => a - b)) {
    const rc = Math.round(reached[n]), cp = Math.round(done[n] || 0);
    out.push({ project: p.app, platform: p.platform, country: 'ALL', level_number: n, reached_users: rc, completed_users: cp, fail_count: Math.max(0, rc - cp) });
  }
  return out;
}

async function postRows(rows) {
  for (let i = 0; i < rows.length; i += 2000) {
    const chunk = rows.slice(i, i + 2000), body = JSON.stringify({ rows: chunk });
    const r = await req(new URL(ANALYTICS_URL).hostname, 'POST', `/api/ingest/app?token=${encodeURIComponent(TOKEN)}`, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, body);
    if (!r.ok) throw new Error('ingest failed: ' + JSON.stringify(r).slice(0, 150));
    console.log(`  写入 ${i + chunk.length}/${rows.length}`);
  }
}

async function postBehavior(events, funnel, levels) {
  for (let i = 0; i < events.length; i += 3000) {
    const body = JSON.stringify({ events: events.slice(i, i + 3000) });
    const r = await req(new URL(ANALYTICS_URL).hostname, 'POST', `/api/ingest/app-behavior?token=${encodeURIComponent(TOKEN)}`, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, body);
    if (!r.ok) throw new Error('behavior(events) failed: ' + JSON.stringify(r).slice(0, 150));
  }
  const body = JSON.stringify({ funnel, levels });
  const r = await req(new URL(ANALYTICS_URL).hostname, 'POST', `/api/ingest/app-behavior?token=${encodeURIComponent(TOKEN)}`, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, body);
  if (!r.ok) throw new Error('behavior(funnel) failed: ' + JSON.stringify(r).slice(0, 150));
  console.log(`  行为:事件 ${events.length} / 漏斗 ${funnel.length} / 关卡 ${levels.length}`);
}

async function main() {
  GTOK = await googleToken();
  const all = [], evRows = [], fnRows = [], lvRows = [], evNames = {};
  for (const p of PROPERTIES) {
    const daily = await fetchByCountry(p);
    const nuDates = [...new Set(daily.filter(x => x.nu > 0).map(x => x.d))].sort();
    const ret = await fetchRetention(p, nuDates);
    for (const x of daily) {
      const rt = ret[x.d] || {};
      all.push({
        stat_date: isoOf(x.d), project: p.app, platform: p.platform, country: x.country,
        new_users: Math.round(x.nu), dau: Math.round(x.au), sessions: Math.round(x.se),
        avg_session_min: r2(x.asd / 60), play_time_min: x.au ? r2(x.dur / x.au / 60) : 0,
        ret_d1: rt.d1 || 0, ret_d7: rt.d7 || 0, ret_d30: rt.d30 || 0,
        iaa_revenue: r2(x.adRev), iap_revenue: r2(Math.max(0, x.totRev - x.adRev)),
        mau: 0, paying_users: 0, ad_impressions: 0, ecpm: 0, src_currency: 'USD',
      });
    }
    // 事件埋点 + 漏斗
    const events = await fetchEvents(p);
    const byDate = {};
    for (const e of events) {
      (byDate[e.d] = byDate[e.d] || {})[e.ev] = { users: e.users, cnt: e.cnt };
      evNames[e.ev] = (evNames[e.ev] || 0) + e.users;
      evRows.push({ stat_date: isoOf(e.d), project: p.app, platform: p.platform, country: 'ALL', event_name: e.ev, event_users: Math.round(e.users), event_count: Math.round(e.cnt) });
    }
    const actSteps = ACTIVATION[p.app] || [], adSteps = AD_FUNNEL[p.app] || [];
    for (const [d, evs] of Object.entries(byDate)) {
      const push = (s, order) => {
        const users = Math.max(0, ...s.cands.map(c => evs[c]?.users || 0));
        if (users > 0) fnRows.push({ stat_date: isoOf(d), project: p.app, platform: p.platform, country: 'ALL', step_order: order, step_key: s.key, step_name: s.name, users: Math.round(users) });
      };
      actSteps.forEach((s, i) => push(s, i));
      adSteps.forEach((s, i) => push(s, 20 + i));
    }
    const lvs = await fetchLevels(p);
    lvRows.push(...lvs);
    console.log(`  ${p.app}-${p.platform}: ${daily.length} 行(国家×日), 留存 ${Object.keys(ret).length} cohort, 事件 ${events.length} 行, 关卡 ${lvs.length}`);
  }
  // 打印事件清单(供漏斗/关卡映射核对)
  const topEv = Object.entries(evNames).sort((a, b) => b[1] - a[1]).slice(0, 60);
  console.log('── GA4 事件清单(按用户量,前60) ──');
  topEv.forEach(([n, u]) => console.log(`  ${n}\t${Math.round(u)}`));
  console.log(`总计 app_daily ${all.length} 行 → ${ANALYTICS_URL}`);
  await postRows(all);
  await postBehavior(evRows, fnRows, lvRows);
  console.log('✅ APP→D1 同步完成(含行为埋点)');
}
main().catch(e => { console.error('ERR', e.message); process.exit(1); });
