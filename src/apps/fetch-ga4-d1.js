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
// 激活漏斗步骤映射(Firebase 常见事件;按实际存在的事件取 max 用户数)
const FUNNEL_STEPS = [
  { key: 'first_open', name: '首次打开', cands: ['first_open'] },
  { key: 'session', name: '会话开始', cands: ['session_start'] },
  { key: 'tutorial', name: '新手引导', cands: ['tutorial_begin', 'tutorial_complete', 'tutorial_start', 'guide_start', 'newbie_guide', 'guide_complete'] },
  { key: 'play', name: '开始游戏/首关', cands: ['level_start', 'level_begin', 'game_start', 'level_up', 'round_start'] },
  { key: 'monetize', name: '变现(广告/内购)', cands: ['ad_impression', 'rewarded_ad', 'ad_reward', 'ad_show', 'rewarded_ad_complete', 'in_app_purchase', 'purchase'] },
];

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
  const all = [], evRows = [], fnRows = [], evNames = {};
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
    for (const [d, evs] of Object.entries(byDate)) {
      FUNNEL_STEPS.forEach((s, i) => {
        const users = Math.max(0, ...s.cands.map(c => evs[c]?.users || 0));
        if (users > 0) fnRows.push({ stat_date: isoOf(d), project: p.app, platform: p.platform, country: 'ALL', step_order: i, step_key: s.key, step_name: s.name, users: Math.round(users) });
      });
    }
    console.log(`  ${p.app}-${p.platform}: ${daily.length} 行(国家×日), 留存 ${Object.keys(ret).length} cohort, 事件 ${events.length} 行`);
  }
  // 打印事件清单(供漏斗/关卡映射核对)
  const topEv = Object.entries(evNames).sort((a, b) => b[1] - a[1]).slice(0, 60);
  console.log('── GA4 事件清单(按用户量,前60) ──');
  topEv.forEach(([n, u]) => console.log(`  ${n}\t${Math.round(u)}`));
  console.log(`总计 app_daily ${all.length} 行 → ${ANALYTICS_URL}`);
  await postRows(all);
  await postBehavior(evRows, fnRows, []);
  console.log('✅ APP→D1 同步完成(含行为埋点)');
}
main().catch(e => { console.error('ERR', e.message); process.exit(1); });
