#!/usr/bin/env node
// 投资人周报/月报 → 多维表 YB8TbS。从日经营(wAsSso)+项目维度(JIKPZV)按周(周一~周日)
// 和自然月聚合,自动生成投资人视角的经营点评。用于每周一对投资人汇报整体经营。
// 口径:营收ROI=收入/消耗;投放ROI=消耗加权ROAS;累计ROI=周/月末快照(回本进度)。
const https = require('https');
const { getFeishuToken } = require('./build-summaries');

const SS = 'J8mswO2vziyIAAkdt4rcVeaDnog';
const BASE = process.env.OVERVIEW_BASE || 'YB8TbS45kaO1gesMtqlc8kpznEb';

function once(method, path, token, body) {
  return new Promise((res, rej) => {
    const d = body ? JSON.stringify(body) : null;
    const h = { 'Content-Type': 'application/json' };
    if (token) h.Authorization = 'Bearer ' + token;
    if (d) h['Content-Length'] = Buffer.byteLength(d);
    const r = https.request({ hostname: 'open.feishu.cn', path, method, headers: h, timeout: 25000 }, rs => {
      const c = []; rs.on('data', x => c.push(x));
      rs.on('end', () => { try { res(JSON.parse(Buffer.concat(c).toString('utf8'))); } catch (e) { res({ _n: 1 }); } });
    });
    r.on('timeout', () => { r.destroy(); rej(new Error('TIMEOUT')); });
    r.on('error', rej); if (d) r.write(d); r.end();
  });
}
async function api(m, p, t, b) {
  const w = a => new Promise(s => setTimeout(s, Math.min(8000, 400 * 2 ** a) + Math.random() * 300));
  for (let a = 0; ; a++) { let r; try { r = await once(m, p, t, b); } catch (e) { if (a >= 7) throw e; await w(a); continue; } if (r && [1254290, 1254291, 90217, 90235].includes(r.code) && a < 7) { await w(a); continue; } return r; }
}
const pnum = v => parseFloat(String(v == null ? '' : v).replace(/[,%]/g, '')) || 0;
const ppct = v => { const s = String(v == null ? '' : v); return s.includes('%') ? pnum(s) / 100 : pnum(s); };
const ser = s => { const m = /(\d{4})[/-](\d{2})[/-](\d{2})/.exec(String(s)); return m ? Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 864e5) : null; };
const mdOf = s => { const d = new Date(s * 864e5); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`; };
const monKey = s => { const d = new Date(s * 864e5); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };
const mondaySer = s => s - ((new Date(s * 864e5).getUTCDay() + 6) % 7);
const f1 = v => Math.round(v * 10) / 10;
const f2 = v => Math.round(v * 100) / 100;
const pc = v => v == null ? '-' : (v >= 0 ? '+' : '') + Math.round(v * 100) + '%';

async function readSheet(token, range) {
  const r = await api('GET', `/open-apis/sheets/v2/spreadsheets/${SS}/values/${range}?valueRenderOption=FormattedValue`, token);
  return r.data?.valueRange?.values || [];
}
async function listTables(token) { return (await api('GET', `/open-apis/bitable/v1/apps/${BASE}/tables?page_size=100`, token)).data?.items || []; }
async function clearRecords(token, tid) {
  let all = [], pt = '';
  do { const r = await api('GET', `/open-apis/bitable/v1/apps/${BASE}/tables/${tid}/records?page_size=500${pt ? '&page_token=' + pt : ''}`, token); (r.data?.items || []).forEach(x => all.push(x.record_id)); pt = r.data?.has_more ? r.data.page_token : ''; } while (pt);
  for (let i = 0; i < all.length; i += 500) await api('POST', `/open-apis/bitable/v1/apps/${BASE}/tables/${tid}/records/batch_delete`, token, { records: all.slice(i, i + 500) });
}
// 复用同名表(清记录),保持 table_id 稳定 → 投资人仪表盘图表不失效。没有才建。
async function recreate(token, name, fields) {
  const old = (await listTables(token)).find(x => x.name === name);
  if (old) { await clearRecords(token, old.table_id); return old.table_id; }
  return (await api('POST', `/open-apis/bitable/v1/apps/${BASE}/tables`, token, { table: { name, fields } })).data?.table_id;
}
async function writeRecs(token, tid, recs) {
  for (let i = 0; i < recs.length; i += 200) await api('POST', `/open-apis/bitable/v1/apps/${BASE}/tables/${tid}/records/batch_create`, token, { records: recs.slice(i, i + 200) });
}

// 聚合一批天 → 经营指标 + 投资人点评
function aggregate(daysInPeriod, allByDate, label, prevAgg) {
  const sp = daysInPeriod.reduce((a, d) => a + d.sp, 0);
  const rev = daysInPeriod.reduce((a, d) => a + d.rev, 0);
  const nu = daysInPeriod.reduce((a, d) => a + d.nu, 0);
  const adW = sp ? daysInPeriod.reduce((a, d) => a + d.sp * d.adRoas, 0) / sp : 0;  // 投放ROI(消耗加权)
  const last = daysInPeriod.slice().sort((a, b) => ser(b.date) - ser(a.date))[0];
  const cumROI = last ? last.cumROI : 0;
  const revROI = sp ? rev / sp : 0;
  const spChg = prevAgg && prevAgg.sp ? (sp - prevAgg.sp) / prevAgg.sp : null;
  const roiChg = prevAgg ? cumROI - prevAgg.cumROI : null;
  // 投资人点评:规模→回本→趋势→判断
  const parts = [];
  parts.push(`投入¥${Math.round(sp).toLocaleString()}${spChg != null ? `(环比${pc(spChg)})` : ''}`);
  parts.push(`回收¥${Math.round(rev).toLocaleString()}`);
  parts.push(`新增${Math.round(nu).toLocaleString()}`);
  parts.push(`累计ROI ${f2(cumROI)}${roiChg != null ? `(${roiChg >= 0 ? '↑' : '↓'}${Math.abs(Math.round(roiChg * 100))}pct)` : ''}`);
  let verdict;
  if (cumROI >= 1) verdict = '✅已回本';
  else if (roiChg != null && roiChg > 0.01) verdict = `📈回本率改善中,距回本差${Math.round((1 - cumROI) * 100)}%`;
  else if (roiChg != null && roiChg < -0.01) verdict = '⚠️回本率下滑,需关注量质';
  else verdict = `回本率持平${f2(cumROI)},尚未回本(差${Math.round((1 - cumROI) * 100)}%)`;
  return { sp, rev, nu, adW, cumROI, revROI, spChg, label, comment: parts.join(' · ') + ' → ' + verdict };
}

async function main() {
  const token = await getFeishuToken();
  const ws = await readSheet(token, 'wAsSso!A2:H80');
  const days = ws.filter(x => x[0] && ser(x[0]))
    .map(x => ({ date: x[0], s: ser(x[0]), sp: pnum(x[1]), rev: pnum(x[2]), adRoas: ppct(x[3]), cumROI: ppct(x[6]), nu: pnum(x[7]) }));

  // ── 周报(周一~周日) ──
  const weeks = {};
  days.forEach(d => { const k = mondaySer(d.s); (weeks[k] = weeks[k] || []).push(d); });
  const wKeys = Object.keys(weeks).map(Number).sort((a, b) => a - b);
  const weekRows = []; let prevW = null;
  wKeys.forEach(k => {
    const ds = weeks[k]; const maxS = Math.max(...ds.map(d => d.s));
    const a = aggregate(ds, days, '', prevW); prevW = a;
    weekRows.push({ fields: {
      '周': `${mdOf(k)}~${mdOf(maxS)}`, '周一': k * 864e5,
      '消耗': f1(a.sp), '收入': f1(a.rev), '营收ROI': f2(a.revROI), '投放ROI': f2(a.adW),
      '累计ROI': f2(a.cumROI), '新增用户': Math.round(a.nu), '消耗环比': pc(a.spChg), '经营点评': a.comment } });
  });
  weekRows.reverse();  // 最新周在上

  // ── 月报 ──
  const months = {};
  days.forEach(d => { const k = monKey(d.s); (months[k] = months[k] || []).push(d); });
  const mKeys = Object.keys(months).sort();
  const monRows = []; let prevM = null;
  mKeys.forEach(k => {
    const ds = months[k]; const a = aggregate(ds, days, k, prevM); prevM = a;
    const firstS = Math.min(...ds.map(d => d.s));
    monRows.push({ fields: {
      '月份': k, '月初': firstS * 864e5,
      '消耗': f1(a.sp), '收入': f1(a.rev), '营收ROI': f2(a.revROI), '投放ROI': f2(a.adW),
      '累计ROI': f2(a.cumROI), '新增用户': Math.round(a.nu), '消耗环比': pc(a.spChg), '经营点评': a.comment } });
  });
  monRows.reverse();

  const wFields = [{ field_name: '周', type: 1 }, { field_name: '周一', type: 5 }, { field_name: '消耗', type: 2 }, { field_name: '收入', type: 2 }, { field_name: '营收ROI', type: 2 }, { field_name: '投放ROI', type: 2 }, { field_name: '累计ROI', type: 2 }, { field_name: '新增用户', type: 2 }, { field_name: '消耗环比', type: 1 }, { field_name: '经营点评', type: 1 }];
  const mFields = [{ field_name: '月份', type: 1 }, { field_name: '月初', type: 5 }, { field_name: '消耗', type: 2 }, { field_name: '收入', type: 2 }, { field_name: '营收ROI', type: 2 }, { field_name: '投放ROI', type: 2 }, { field_name: '累计ROI', type: 2 }, { field_name: '新增用户', type: 2 }, { field_name: '消耗环比', type: 1 }, { field_name: '经营点评', type: 1 }];
  const wTid = await recreate(token, '数据周报', wFields); await writeRecs(token, wTid, weekRows);
  const mTid = await recreate(token, '数据月报', mFields); await writeRecs(token, mTid, monRows);
  console.log(`✅ 数据周报 ${weekRows.length} 周 (${wTid})`);
  console.log(`✅ 数据月报 ${monRows.length} 月 (${mTid})`);
  return { wTid, mTid };
}

if (require.main === module) main().catch(e => { console.error('ERR', e.message); process.exit(1); });
module.exports = { main };
