#!/usr/bin/env node
// APP 线:GA4 Data API → 飞书多维表「APP经营数据中心」(Fw8BbucPvaVdl8saebuc6FngnFg)。
// 三张表:APP-每日指标(全量历史,每日整表刷新=永久自愈)/ APP-近30天(看板数据源)/ APP-国家维度(近30天)。
// 留存(次留/7/14/30)用 cohort 报告(firstSessionDate 分组),只查有新增的日期。
// 认证:服务账号 JSON(env GA4_SA_JSON)→ JWT RS256 → access token。
// 口径注意:GA4 活跃=有互动事件,新增=first_open,与 TikTok Portal 口径不可直接对比。
const https = require('https');
const crypto = require('crypto');

const PROPERTIES = [
  { app: '麻将', platform: 'iOS', res: '麻将-iOS', property: '531751891' },
  { app: '麻将', platform: 'GooglePlay', res: '麻将-GP', property: '539961183' },
  { app: '积木', platform: 'iOS', res: '积木-iOS', property: '539468626' },
  { app: '积木', platform: 'GooglePlay', res: '积木-GP', property: '539517442' },
];
const BASE = 'Fw8BbucPvaVdl8saebuc6FngnFg';
const DAYS = parseInt(process.env.GA4_DAYS || '365', 10);   // 全量窗口(整表刷新→历史缺口自愈)
const WINDOW = 30;                                          // 看板/国家维度窗口
const FEISHU_APP_ID = process.env.FEISHU_APP_ID || 'cli_aa898a664d395cc2';
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || (() => { throw new Error('FEISHU_APP_SECRET required'); })();
const SA = JSON.parse(process.env.GA4_SA_JSON || (() => { throw new Error('GA4_SA_JSON required(服务账号JSON)'); })());

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
  const r = await req('oauth2.googleapis.com', 'POST', '/token',
    { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }, body);
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

async function feishu(method, path, token, body) {
  const wait = a => new Promise(s => setTimeout(s, Math.min(15000, 500 * 2 ** a)));
  for (let a = 0; ; a++) {
    try {
      const h = { 'Content-Type': 'application/json' }; if (token) h.Authorization = 'Bearer ' + token;
      const d = body ? JSON.stringify(body) : null; if (d) h['Content-Length'] = Buffer.byteLength(d);
      const r = await req('open.feishu.cn', method, path, h, d);
      if (r && [90217, 90235, 1254290, 1254291].includes(r.code) && a < 8) { await wait(a); continue; }
      return r;
    } catch (e) { if (a >= 8) throw e; await wait(a); }
  }
}

const isoOf = d8 => `${d8.slice(0, 4)}-${d8.slice(4, 6)}-${d8.slice(6, 8)}`;
const msOf = d8 => Date.UTC(+d8.slice(0, 4), +d8.slice(4, 6) - 1, +d8.slice(6, 8));
const r1 = v => Math.round(v * 10) / 10;
const r2 = v => Math.round(v * 100) / 100;
const r4 = v => Math.round(v * 10000) / 10000;

// ── GA4 拉取 ─────────────────────────────────────────────────────────────────

const METRICS = ['activeUsers', 'newUsers', 'sessions', 'engagedSessions',
  'userEngagementDuration', 'averageSessionDuration', 'screenPageViews', 'totalAdRevenue', 'totalRevenue'];

async function fetchDaily(p) {
  const r = await ga4(p.property, {
    dateRanges: [{ startDate: `${DAYS}daysAgo`, endDate: 'yesterday' }],
    dimensions: [{ name: 'date' }], metrics: METRICS.map(m => ({ name: m })), limit: 5000,
  });
  const out = {};
  for (const row of r.rows || []) {
    const d = row.dimensionValues[0].value;
    if (!/^\d{8}$/.test(d)) continue;
    const [au, nu, se, es, dur, asd, pv, adRev, totRev] = row.metricValues.map(v => parseFloat(v.value) || 0);
    out[d] = { au, nu, se, es, dur, asd, pv, adRev, totRev };
  }
  return out;
}

// cohort 留存:每请求最多 12 个 cohort(日期),offset 0~30 天
async function fetchRetention(p, dates) {
  const ret = {};
  for (let i = 0; i < dates.length; i += 12) {
    const chunk = dates.slice(i, i + 12);
    const r = await ga4(p.property, {
      dimensions: [{ name: 'cohort' }, { name: 'cohortNthDay' }],
      metrics: [{ name: 'cohortActiveUsers' }],
      cohortSpec: {
        cohorts: chunk.map(d => ({ name: d, dimension: 'firstSessionDate', dateRange: { startDate: isoOf(d), endDate: isoOf(d) } })),
        cohortsRange: { granularity: 'DAILY', startOffset: 0, endOffset: 30 },
      },
      limit: 5000,
    });
    const grid = {};   // date → nthDay → users
    for (const row of r.rows || []) {
      const [c, nth] = row.dimensionValues.map(v => v.value);
      (grid[c] = grid[c] || {})[parseInt(nth, 10)] = parseFloat(row.metricValues[0].value) || 0;
    }
    for (const [d, g] of Object.entries(grid)) {
      const base = g[0] || 0; if (!base) continue;
      ret[d] = { base, d1: g[1] != null ? r4(g[1] / base) : null, d7: g[7] != null ? r4(g[7] / base) : null, d14: g[14] != null ? r4(g[14] / base) : null, d30: g[30] != null ? r4(g[30] / base) : null };
    }
  }
  return ret;
}

async function fetchCountry(p) {
  const r = await ga4(p.property, {
    dateRanges: [{ startDate: `${WINDOW}daysAgo`, endDate: 'yesterday' }],
    dimensions: [{ name: 'date' }, { name: 'country' }],
    metrics: ['activeUsers', 'newUsers', 'totalAdRevenue', 'totalRevenue'].map(m => ({ name: m })),
    limit: 10000,
  });
  const out = [];
  for (const row of r.rows || []) {
    const d = row.dimensionValues[0].value, country = row.dimensionValues[1].value || '(unknown)';
    if (!/^\d{8}$/.test(d)) continue;
    const [au, nu, adRev, totRev] = row.metricValues.map(v => parseFloat(v.value) || 0);
    if (au || nu || adRev || totRev) out.push({ d, country, au, nu, adRev, totRev });
  }
  return out;
}

// ── 飞书写入 ─────────────────────────────────────────────────────────────────

const PCT = f => ({ field_name: f, type: 2, property: { formatter: '0.00%' } });
const NUM = f => ({ field_name: f, type: 2 });
const TXT = f => ({ field_name: f, type: 1 });
const DAT = f => ({ field_name: f, type: 5, property: { date_formatter: 'yyyy/MM/dd' } });

const DAILY_FIELDS = [
  TXT('资源'), TXT('应用'), TXT('平台'), DAT('日期'), TXT('月份'), TXT('是否昨日'),
  NUM('活跃用户'), NUM('新增用户'), NUM('会话数'), NUM('互动会话数'), PCT('互动率'),
  NUM('人均会话数'), NUM('人均使用时长(分)'), NUM('次均会话时长(分)'), NUM('屏幕浏览量'),
  NUM('广告收入'), NUM('总收入'), NUM('ARPDAU'),
  PCT('次留'), PCT('7日留存'), PCT('14日留存'), PCT('30日留存'),
];
const COUNTRY_FIELDS = [
  TXT('资源'), TXT('应用'), TXT('平台'), DAT('日期'), TXT('月份'), TXT('国家'),
  NUM('活跃用户'), NUM('新增用户'), NUM('广告收入'), NUM('总收入'),
];

async function ensureTable(ft, tables, name, FIELDS) {
  let tid = tables.find(x => x.name === name)?.table_id;
  if (tid) {
    let all = [], pt = '';
    do { const r = await feishu('GET', `/open-apis/bitable/v1/apps/${BASE}/tables/${tid}/records?page_size=500${pt ? '&page_token=' + pt : ''}`, ft); (r.data?.items || []).forEach(x => all.push(x.record_id)); pt = r.data?.has_more ? r.data.page_token : ''; } while (pt);
    for (let i = 0; i < all.length; i += 500) await feishu('POST', `/open-apis/bitable/v1/apps/${BASE}/tables/${tid}/records/batch_delete`, ft, { records: all.slice(i, i + 500) });
    const exist = new Set(((await feishu('GET', `/open-apis/bitable/v1/apps/${BASE}/tables/${tid}/fields?page_size=100`, ft)).data?.items || []).map(x => x.field_name));
    for (const f of FIELDS) if (!exist.has(f.field_name)) await feishu('POST', `/open-apis/bitable/v1/apps/${BASE}/tables/${tid}/fields`, ft, f);
  } else {
    const r = await feishu('POST', `/open-apis/bitable/v1/apps/${BASE}/tables`, ft, { table: { name, fields: FIELDS } });
    if (r.code !== 0) throw new Error(`create ${name}: ` + JSON.stringify(r).slice(0, 150));
    tid = r.data.table_id;
  }
  return tid;
}

async function writeRecs(ft, tid, name, recs) {
  for (let i = 0; i < recs.length; i += 200) {
    const w = await feishu('POST', `/open-apis/bitable/v1/apps/${BASE}/tables/${tid}/records/batch_create`, ft, { records: recs.slice(i, i + 200) });
    if (w.code !== 0) throw new Error(`write ${name}: ` + JSON.stringify(w).slice(0, 150));
  }
  console.log(`  ✅ ${name}: ${recs.length} 行`);
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  GTOK = await googleToken();

  // 先拉全部数据,全部成功后才动表(避免清表后写入失败丢数据)
  const dailyRecs = [], countryRecs = [];
  let maxDate = '';
  for (const p of PROPERTIES) {
    const daily = await fetchDaily(p);
    const nuDates = Object.keys(daily).filter(d => daily[d].nu > 0).sort();
    const ret = await fetchRetention(p, nuDates);
    const country = await fetchCountry(p);
    console.log(`  ${p.res}: ${Object.keys(daily).length} 天, 留存 ${Object.keys(ret).length} cohort, 国家 ${country.length} 行`);
    for (const [d, v] of Object.entries(daily)) {
      if (d > maxDate) maxDate = d;
      const f = {
        '资源': p.res, '应用': p.app, '平台': p.platform, '日期': msOf(d), '月份': isoOf(d).slice(0, 7),
        '活跃用户': Math.round(v.au), '新增用户': Math.round(v.nu), '会话数': Math.round(v.se),
        '互动会话数': Math.round(v.es), '互动率': v.se ? r4(v.es / v.se) : 0,
        '人均会话数': v.au ? r2(v.se / v.au) : 0,
        '人均使用时长(分)': v.au ? r1(v.dur / v.au / 60) : 0,
        '次均会话时长(分)': r1(v.asd / 60),
        '屏幕浏览量': Math.round(v.pv),
        '广告收入': r2(v.adRev), '总收入': r2(v.totRev), 'ARPDAU': v.au ? r4(v.totRev / v.au) : 0,
      };
      const rt = ret[d];
      if (rt) { if (rt.d1 != null) f['次留'] = rt.d1; if (rt.d7 != null) f['7日留存'] = rt.d7; if (rt.d14 != null) f['14日留存'] = rt.d14; if (rt.d30 != null) f['30日留存'] = rt.d30; }
      dailyRecs.push({ fields: f, _d: d });
    }
    for (const c of country) countryRecs.push({ fields: {
      '资源': p.res, '应用': p.app, '平台': p.platform, '日期': msOf(c.d), '月份': isoOf(c.d).slice(0, 7), '国家': c.country,
      '活跃用户': Math.round(c.au), '新增用户': Math.round(c.nu), '广告收入': r2(c.adRev), '总收入': r2(c.totRev),
    } });
  }
  dailyRecs.forEach(r => { r.fields['是否昨日'] = r._d === maxDate ? '是' : ''; });
  dailyRecs.sort((a, b) => b.fields['日期'] - a.fields['日期']);
  countryRecs.sort((a, b) => b.fields['日期'] - a.fields['日期'] || b.fields['广告收入'] - a.fields['广告收入']);

  const cutoff = msOf(maxDate) - (WINDOW - 1) * 864e5;
  const windowRecs = dailyRecs.filter(r => r.fields['日期'] >= cutoff).map(r => ({ fields: r.fields }));

  const ft = (await feishu('POST', '/open-apis/auth/v3/tenant_access_token/internal', null,
    { app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET })).tenant_access_token;
  const tables = (await feishu('GET', `/open-apis/bitable/v1/apps/${BASE}/tables?page_size=50`, ft)).data?.items || [];

  const dailyT = await ensureTable(ft, tables, 'APP-每日指标', DAILY_FIELDS);
  await writeRecs(ft, dailyT, 'APP-每日指标', dailyRecs.map(r => ({ fields: r.fields })));
  const winT = await ensureTable(ft, tables, 'APP-近30天', DAILY_FIELDS);
  await writeRecs(ft, winT, 'APP-近30天', windowRecs);
  const ctyT = await ensureTable(ft, tables, 'APP-国家维度', COUNTRY_FIELDS);
  await writeRecs(ft, ctyT, 'APP-国家维度', countryRecs);

  console.log(`✅ APP线同步完成(最新数据日 ${isoOf(maxDate)})`);
}
main().catch(e => { console.error('ERR', e.message); process.exit(1); });
