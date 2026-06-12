#!/usr/bin/env node
// APP 线:GA4 Data API → 飞书多维表「APP经营数据中心」。
// 4 个媒体资源(麻将/积木 × iOS/GP),每日核心指标,近 N 天窗口写入(幂等清写)。
// 认证:服务账号 JSON(env GA4_SA_JSON,整段 JSON 字符串)→ JWT → access token。
const https = require('https');
const crypto = require('crypto');

const PROPERTIES = [
  { app: '麻将', platform: 'iOS', property: '531751891' },
  { app: '麻将', platform: 'GooglePlay', property: '539961183' },
  { app: '积木', platform: 'iOS', property: '539468626' },
  { app: '积木', platform: 'GooglePlay', property: '539517442' },
];
const BASE = 'Fw8BbucPvaVdl8saebuc6FngnFg';   // APP经营数据中心
const TABLE = 'APP-每日指标';
const DAYS = parseInt(process.env.GA4_DAYS || '30', 10);
const FEISHU_APP_ID = process.env.FEISHU_APP_ID || 'cli_aa898a664d395cc2';
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || (() => { throw new Error('FEISHU_APP_SECRET required'); })();
const SA = JSON.parse(process.env.GA4_SA_JSON || (() => { throw new Error('GA4_SA_JSON required(服务账号JSON)'); })());

function req(host, method, path, headers, body) {
  return new Promise((res, rej) => {
    const r = https.request({ hostname: host, path, method, headers, timeout: 30000 }, rs => {
      const c = []; rs.on('data', x => c.push(x));
      rs.on('end', () => { try { res(JSON.parse(Buffer.concat(c).toString('utf8'))); } catch (e) { rej(new Error('non-JSON: ' + Buffer.concat(c).toString().slice(0, 150))); } });
    });
    r.on('timeout', () => { r.destroy(); rej(new Error('timeout')); }); r.on('error', rej);
    if (body) r.write(body); r.end();
  });
}

// 服务账号 JWT → Google access token(scope: analytics.readonly)
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

const METRICS = ['activeUsers', 'newUsers', 'sessions', 'engagedSessions', 'userEngagementDuration', 'totalAdRevenue', 'totalRevenue'];

async function runReport(gtok, property) {
  const body = JSON.stringify({
    dateRanges: [{ startDate: `${DAYS}daysAgo`, endDate: 'yesterday' }],
    dimensions: [{ name: 'date' }],
    metrics: METRICS.map(m => ({ name: m })),
    limit: 1000,
  });
  const r = await req('analyticsdata.googleapis.com', 'POST', `/v1beta/properties/${property}:runReport`,
    { Authorization: 'Bearer ' + gtok, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, body);
  if (r.error) throw new Error(`GA4 ${property}: ${r.error.message}`);
  return (r.rows || []).map(row => ({
    date: row.dimensionValues[0].value,                       // YYYYMMDD
    vals: row.metricValues.map(v => parseFloat(v.value) || 0),
  }));
}

async function main() {
  const gtok = await googleToken();
  const ft = (await feishu('POST', '/open-apis/auth/v3/tenant_access_token/internal', null,
    { app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET })).tenant_access_token;

  const FIELDS = [
    { field_name: '应用', type: 1 }, { field_name: '平台', type: 1 }, { field_name: '日期', type: 5 },
    { field_name: '活跃用户', type: 2 }, { field_name: '新增用户', type: 2 }, { field_name: '会话数', type: 2 },
    { field_name: '互动会话数', type: 2 }, { field_name: '人均使用时长(分)', type: 2 },
    { field_name: '广告收入', type: 2 }, { field_name: '总收入', type: 2 }, { field_name: '是否昨日', type: 1 },
  ];
  const tables = (await feishu('GET', `/open-apis/bitable/v1/apps/${BASE}/tables?page_size=50`, ft)).data?.items || [];
  let tid = tables.find(x => x.name === TABLE)?.table_id;
  if (tid) {
    let all = [], pt = '';
    do { const r = await feishu('GET', `/open-apis/bitable/v1/apps/${BASE}/tables/${tid}/records?page_size=500${pt ? '&page_token=' + pt : ''}`, ft); (r.data?.items || []).forEach(x => all.push(x.record_id)); pt = r.data?.has_more ? r.data.page_token : ''; } while (pt);
    for (let i = 0; i < all.length; i += 500) await feishu('POST', `/open-apis/bitable/v1/apps/${BASE}/tables/${tid}/records/batch_delete`, ft, { records: all.slice(i, i + 500) });
    const exist = new Set(((await feishu('GET', `/open-apis/bitable/v1/apps/${BASE}/tables/${tid}/fields?page_size=100`, ft)).data?.items || []).map(x => x.field_name));
    for (const f of FIELDS) if (!exist.has(f.field_name)) await feishu('POST', `/open-apis/bitable/v1/apps/${BASE}/tables/${tid}/fields`, ft, { field_name: f.field_name, type: f.type });
  } else tid = (await feishu('POST', `/open-apis/bitable/v1/apps/${BASE}/tables`, ft, { table: { name: TABLE, fields: FIELDS } })).data?.table_id;

  const recs = [];
  let maxDate = '';
  for (const p of PROPERTIES) {
    const rows = await runReport(gtok, p.property);
    console.log(`  ${p.app}-${p.platform}: ${rows.length} 天`);
    for (const row of rows) {
      if (row.date > maxDate) maxDate = row.date;
      const ms = Date.UTC(+row.date.slice(0, 4), +row.date.slice(4, 6) - 1, +row.date.slice(6, 8));
      const [au, nu, se, es, dur, adRev, totRev] = row.vals;
      recs.push({ fields: {
        '应用': p.app, '平台': p.platform, '日期': ms,
        '活跃用户': Math.round(au), '新增用户': Math.round(nu), '会话数': Math.round(se),
        '互动会话数': Math.round(es), '人均使用时长(分)': au ? Math.round(dur / au / 60 * 10) / 10 : 0,
        '广告收入': Math.round(adRev * 100) / 100, '总收入': Math.round(totRev * 100) / 100,
        '_d': row.date,
      } });
    }
  }
  recs.forEach(r => { r.fields['是否昨日'] = r.fields._d === maxDate ? '是' : ''; delete r.fields._d; });
  recs.sort((a, b) => b.fields['日期'] - a.fields['日期']);
  for (let i = 0; i < recs.length; i += 200) {
    const w = await feishu('POST', `/open-apis/bitable/v1/apps/${BASE}/tables/${tid}/records/batch_create`, ft, { records: recs.slice(i, i + 200) });
    if (w.code !== 0) throw new Error('write: ' + JSON.stringify(w).slice(0, 150));
  }
  console.log(`✅ APP-每日指标 ${recs.length} 行(4资源×${DAYS}天窗口, ${tid})`);
}
main().catch(e => { console.error('ERR', e.message); process.exit(1); });
