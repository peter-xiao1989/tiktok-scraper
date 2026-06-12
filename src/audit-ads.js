#!/usr/bin/env node
// 投放数据对账:用 TikTok API 拉「账户级」近 N 天日消耗总量,与投放原表内
// 同账户同日合计对比。差额>阈值 → 飞书告警(列出账户/日期/差额)。
// 目的:抓出"自愈回看也补不回"的缺口(如账户未授权/被移出 BC),当天发现当天处理。
// 挂 daily-ads workflow(导入后运行)。AUDIT_DAYS 默认 7。
const https = require('https');

const SS = 'J8mswO2vziyIAAkdt4rcVeaDnog';
const FEISHU_APP_ID = process.env.FEISHU_APP_ID || 'cli_aa898a664d395cc2';
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || (() => { throw new Error('FEISHU_APP_SECRET required'); })();
const ACCESS_TOKEN = process.env.TIKTOK_ACCESS_TOKEN;
const THRESHOLD = parseFloat(process.env.AUDIT_THRESHOLD || '1');   // 美元
const DAYS = parseInt(process.env.AUDIT_DAYS || '7', 10);

function req(host, method, path, headers, body) {
  return new Promise((res, rej) => {
    const r = https.request({ hostname: host, path, method, headers, timeout: 30000 }, rs => {
      const c = []; rs.on('data', x => c.push(x));
      rs.on('end', () => { try { res(JSON.parse(Buffer.concat(c).toString('utf8'))); } catch (e) { rej(new Error('non-JSON: ' + Buffer.concat(c).toString().slice(0, 120))); } });
    });
    r.on('timeout', () => { r.destroy(); rej(new Error('timeout')); }); r.on('error', rej);
    if (body) r.write(body); r.end();
  });
}
async function feishu(method, path, token, body) {
  const wait = a => new Promise(s => setTimeout(s, Math.min(15000, 500 * 2 ** a)));
  for (let a = 0; ; a++) {
    try {
      const h = { 'Content-Type': 'application/json' }; if (token) h.Authorization = 'Bearer ' + token;
      const d = body ? JSON.stringify(body) : null; if (d) h['Content-Length'] = Buffer.byteLength(d);
      const r = await req('open.feishu.cn', method, path, h, d);
      if (r && (r.code === 90217 || r.code === 90235) && a < 8) { await wait(a); continue; }
      return r;
    } catch (e) { if (a >= 8) throw e; await wait(a); }
  }
}
async function tiktok(path) {
  for (let a = 0; ; a++) {
    try { return await req('business-api.tiktok.com', 'GET', path, { 'Access-Token': ACCESS_TOKEN }); }
    catch (e) { if (a >= 5) throw e; await new Promise(s => setTimeout(s, 2000 * (a + 1))); }
  }
}
const pnum = v => parseFloat(String(v == null ? '' : v).replace(/[,%]/g, '')) || 0;

async function main() {
  if (!ACCESS_TOKEN) { console.error('TIKTOK_ACCESS_TOKEN required'); process.exit(1); }
  const ft = (await feishu('POST', '/open-apis/auth/v3/tenant_access_token/internal', null,
    { app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET })).tenant_access_token;

  // 账户列表(与 ads-api 同源:oauth + bc)
  const ids = new Set();
  try {
    const qs = new URLSearchParams({ app_id: process.env.TIKTOK_APP_ID, secret: process.env.TIKTOK_APP_SECRET, access_token: ACCESS_TOKEN }).toString();
    const r = await tiktok(`/open_api/v1.3/oauth2/advertiser/get/?${qs}`);
    if (r.code !== 0) console.warn('[warn] oauth list:', r.message);
    (r.data?.list || []).forEach(a => ids.add(String(a.advertiser_id)));
  } catch (e) { console.warn('[warn] oauth list:', e.message); }
  // BC 资产枚举:抓"在 BC 里但 oauth 没授权"的账户(bc/advertiser/list 是不存在的路径,404)
  if (process.env.TIKTOK_BC_ID) {
    try {
      for (let page = 1; page < 10; page++) {
        const qs = new URLSearchParams({ bc_id: process.env.TIKTOK_BC_ID, asset_type: 'ADVERTISER', page, page_size: 50 }).toString();
        const r = await tiktok(`/open_api/v1.3/bc/asset/get/?${qs}`);
        if (r.code !== 0) { console.warn('[warn] bc/asset/get:', r.message); break; }
        const list = r.data?.list || []; list.forEach(a => ids.add(String(a.asset_id || a.advertiser_id)));
        if (!r.data?.page_info?.has_more && list.length < 50) break;
      }
    } catch (e) { console.warn('[warn] bc/asset/get:', e.message); }
  }
  const advIds = [...ids];
  console.log(`advertisers: ${advIds.length}`);

  // 账户名(对账报告里可读)
  const nameMap = {};
  for (let i = 0; i < advIds.length; i += 100) {
    const qs = new URLSearchParams({ advertiser_ids: JSON.stringify(advIds.slice(i, i + 100)), fields: JSON.stringify(['advertiser_id', 'name']) }).toString();
    const r = await tiktok(`/open_api/v1.3/advertiser/info/?${qs}`);
    (r.data?.list || []).forEach(a => { nameMap[String(a.advertiser_id)] = a.name; });
  }

  const end = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  const start = new Date(Date.now() - DAYS * 864e5).toISOString().slice(0, 10);

  // API 侧:账户×日 消耗(ADVERTISER 级 report,1次/账户)
  const apiSpend = {};  // name|date → spend
  for (const id of advIds) {
    const qs = new URLSearchParams({
      advertiser_id: id, report_type: 'BASIC', data_level: 'AUCTION_ADVERTISER',
      dimensions: JSON.stringify(['advertiser_id', 'stat_time_day']),
      metrics: JSON.stringify(['spend']),
      start_date: start, end_date: end, page_size: 100,
    }).toString();
    const r = await tiktok(`/open_api/v1.3/report/integrated/get/?${qs}`);
    if (r.code !== 0) { console.warn(`[warn] report ${id}: ${r.message}`); continue; }
    for (const row of r.data?.list || []) {
      const d = (row.dimensions?.stat_time_day || '').slice(0, 10);
      const nm = nameMap[id] || id;
      apiSpend[`${nm}|${d}`] = (apiSpend[`${nm}|${d}`] || 0) + pnum(row.metrics?.spend);
    }
  }

  // 表内:账户×日 合计
  const sheetSpend = {};
  let s = 2;
  while (s < 20000) {
    const r = await feishu('GET', `/open-apis/sheets/v2/spreadsheets/${SS}/values/uqJEhq!B${s}:N${s + 499}`, ft);
    const rows = r.data?.valueRange?.values || []; if (!rows.length) break;
    rows.forEach(x => {
      const d = x[2], nm = x[12];
      if (!d || !nm || d < start || d > end) return;
      sheetSpend[`${nm}|${d}`] = (sheetSpend[`${nm}|${d}`] || 0) + pnum(x[3]);
    });
    if (rows.length < 500) break; s += 500;
  }

  // 对比
  const diffs = [];
  for (const [k, v] of Object.entries(apiSpend)) {
    const sv = sheetSpend[k] || 0;
    if (Math.abs(v - sv) > THRESHOLD) diffs.push({ k, api: v, sheet: sv });
  }
  diffs.sort((a, b) => Math.abs(b.api - b.sheet) - Math.abs(a.api - a.sheet));
  if (!diffs.length) { console.log(`✅ 对账通过(${start}~${end},阈值$${THRESHOLD})`); return; }

  console.log(`⚠️ 对账差异 ${diffs.length} 条:`);
  diffs.forEach(d => console.log(`  ${d.k}: API $${d.api.toFixed(2)} vs 表 $${d.sheet.toFixed(2)}`));
  const webhook = process.env.FEISHU_WEBHOOK;
  if (webhook) {
    const lines = diffs.slice(0, 10).map(d => `${d.k.replace('|', ' ')} API$${d.api.toFixed(1)}≠表$${d.sheet.toFixed(1)}`).join('\n');
    const u = new URL(webhook);
    await req(u.hostname, 'POST', u.pathname, { 'Content-Type': 'application/json' },
      JSON.stringify({ msg_type: 'text', content: { text: `⚠️ 投放数据·对账差异 ${diffs.length} 条(${start}~${end})\n${lines}` } }));
  }
  process.exitCode = 0;  // 告警但不红 workflow
}
main().catch(e => { console.error('AUDIT ERR', e.message); process.exit(0); });
