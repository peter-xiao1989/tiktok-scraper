#!/usr/bin/env node
// 游戏质量分析 → 多维表 YB8TbS。从产品原表(c50205,product-api 抓的)读留存/LTV/ARPU/
// 付费/首日ROI,建「游戏质量分析」表,供投资人看用户质量与回收能力。
// 这些数据 product-api 一直在抓,只是之前没接进分析。复用表清记录保 table_id 稳定。
const https = require('https');
const { getFeishuToken } = require('./build-summaries');

const SS = 'J8mswO2vziyIAAkdt4rcVeaDnog';
const BASE = process.env.OVERVIEW_BASE || 'YB8TbS45kaO1gesMtqlc8kpznEb';
const TABLE = '游戏质量分析';

function once(m, p, t, b) {
  return new Promise((res, rej) => {
    const d = b ? JSON.stringify(b) : null; const h = { 'Content-Type': 'application/json' };
    if (t) h.Authorization = 'Bearer ' + t; if (d) h['Content-Length'] = Buffer.byteLength(d);
    const r = https.request({ hostname: 'open.feishu.cn', path: p, method: m, headers: h, timeout: 25000 }, rs => {
      const c = []; rs.on('data', x => c.push(x)); rs.on('end', () => { try { res(JSON.parse(Buffer.concat(c).toString('utf8'))); } catch (e) { res({ _n: 1 }); } });
    });
    r.on('timeout', () => { r.destroy(); rej(new Error('TIMEOUT')); }); r.on('error', rej); if (d) r.write(d); r.end();
  });
}
async function api(m, p, t, b) {
  const w = a => new Promise(s => setTimeout(s, Math.min(8000, 400 * 2 ** a) + Math.random() * 300));
  for (let a = 0; ; a++) { let r; try { r = await once(m, p, t, b); } catch (e) { if (a >= 7) throw e; await w(a); continue; } if (r && [1254290, 1254291, 90217, 90235].includes(r.code) && a < 7) { await w(a); continue; } return r; }
}
const pnum = v => parseFloat(String(v == null ? '' : v).replace(/[,%]/g, '')) || 0;
const ppct = v => { const s = String(v == null ? '' : v); return s.includes('%') ? pnum(s) / 100 : pnum(s); };
const ser = s => { const m = /(\d{4})[/-](\d{2})[/-](\d{2})/.exec(String(s)); return m ? Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 864e5) : null; };
const f2 = v => Math.round(v * 100) / 100;

async function readCols(token, sheet, a, b) {
  let out = [], s = 2;
  while (s < 500000) { const r = await api('GET', `/open-apis/sheets/v2/spreadsheets/${SS}/values/${sheet}!${a}${s}:${b}${s + 499}?valueRenderOption=FormattedValue`, token); const rows = r.data?.valueRange?.values || []; if (!rows.length) break; out = out.concat(rows); if (rows.length < 500) break; s += 500; }
  return out;
}
async function listTables(token) { return (await api('GET', `/open-apis/bitable/v1/apps/${BASE}/tables?page_size=100`, token)).data?.items || []; }
async function clearRecords(token, tid) {
  let all = [], pt = '';
  do { const r = await api('GET', `/open-apis/bitable/v1/apps/${BASE}/tables/${tid}/records?page_size=500${pt ? '&page_token=' + pt : ''}`, token); (r.data?.items || []).forEach(x => all.push(x.record_id)); pt = r.data?.has_more ? r.data.page_token : ''; } while (pt);
  for (let i = 0; i < all.length; i += 500) await api('POST', `/open-apis/bitable/v1/apps/${BASE}/tables/${tid}/records/batch_delete`, token, { records: all.slice(i, i + 500) });
}

const FIELDS = [
  { field_name: '游戏名称', type: 1 }, { field_name: '项目组', type: 1 }, { field_name: '日期', type: 5 },
  { field_name: '新增用户', type: 2 }, { field_name: '次留', type: 2 }, { field_name: '7日留存', type: 2 },
  { field_name: '首日LTV', type: 2 }, { field_name: '首日ARPU', type: 2 }, { field_name: '首日ROI', type: 2 }, { field_name: '付费收入', type: 2 },
];

async function main() {
  const token = await getFeishuToken();
  // 产品原表 c50205 B:AO — B项目组0 C游戏1 D日期2 E新增3 R次留16 S7留17 AE付费29 AG_ARPU31 AI_LTV33 AJ首日ROI34
  const rows = await readCols(token, 'c50205', 'B', 'AO');
  const recs = [];
  rows.forEach(r => {
    const grp = r[0], game = r[1], date = r[2]; if (!game || !ser(date)) return;
    const ret1 = ppct(r[16]), ret7 = ppct(r[17]), ltv = pnum(r[33]), arpu = pnum(r[31]), d1roi = ppct(r[34]), pay = pnum(r[29]), nu = pnum(r[3]);
    if (ret1 <= 0 && ltv <= 0 && pay <= 0) return;  // 只保留有质量数据的(激活批次)
    recs.push({ fields: {
      '游戏名称': game, '项目组': grp, '日期': ser(date) * 864e5, '新增用户': Math.round(nu),
      '次留': f2(ret1), '7日留存': f2(ret7), '首日LTV': f2(ltv), '首日ARPU': f2(arpu), '首日ROI': f2(d1roi), '付费收入': f2(pay) } });
  });
  recs.sort((a, b) => b.fields['日期'] - a.fields['日期']);  // 最新在上

  let tid = (await listTables(token)).find(x => x.name === TABLE)?.table_id;
  if (tid) await clearRecords(token, tid);
  else tid = (await api('POST', `/open-apis/bitable/v1/apps/${BASE}/tables`, token, { table: { name: TABLE, fields: FIELDS } })).data?.table_id;
  for (let i = 0; i < recs.length; i += 200) { const w = await api('POST', `/open-apis/bitable/v1/apps/${BASE}/tables/${tid}/records/batch_create`, token, { records: recs.slice(i, i + 200) }); if (w.code !== 0) throw new Error('write: ' + JSON.stringify(w).slice(0, 100)); }
  console.log(`✅ 游戏质量分析 ${recs.length} 行 (${tid})`);
  return tid;
}
if (require.main === module) main().catch(e => { console.error('ERR', e.message); process.exit(1); });
module.exports = { main };
