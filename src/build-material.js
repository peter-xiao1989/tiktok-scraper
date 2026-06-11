#!/usr/bin/env node
// 素材分析(近30天) → 多维表,给投放同学的素材决策表。
// 核心:自动评级(同项目内对比,跨项目无意义):
//   🆕新素材   首投 ≤7 天(先观察,不急着判)
//   🌟放大复刻 消耗≥50 且 ROI ≥ max(项目均值×1.2, 项目均值+0.1)——验证过的好素材
//   🔴建议止损 消耗≥30 且 ROI ≤ 项目均值×0.5——费钱不出效果
//   ⚠️衰退     历史消耗≥30 但近3日日均 < 整体日均一半——跑量下滑
//   ✅在投     其余正常
const https = require('https');
const { getFeishuToken } = require('./build-summaries');

const SS = 'J8mswO2vziyIAAkdt4rcVeaDnog';
const BASE = process.env.OVERVIEW_BASE || 'YB8TbS45kaO1gesMtqlc8kpznEb';
const TABLE = '素材分析(近30天)';

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
const serAny = s => { const str = String(s == null ? '' : s).trim(); if (/^\d{5}(\.\d+)?$/.test(str)) return Math.round(+str); const m = /(\d{4})[/-](\d{1,2})[/-](\d{1,2})/.exec(str); return m ? Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 864e5) + 25569 : null; };
const f1 = v => Math.round(v * 10) / 10;
const f2 = v => Math.round(v * 100) / 100;

async function readRows(token, sheet, a, b) {
  let out = [], s = 2;
  while (s < 6000) { const r = await api('GET', `/open-apis/sheets/v2/spreadsheets/${SS}/values/${sheet}!${a}${s}:${b}${s + 499}?valueRenderOption=FormattedValue`, token); const rows = r.data?.valueRange?.values || []; if (!rows.length) break; out = out.concat(rows); if (rows.length < 500) break; s += 500; }
  return out;
}
async function listTables(token) { return (await api('GET', `/open-apis/bitable/v1/apps/${BASE}/tables?page_size=100`, token)).data?.items || []; }
async function clearRecords(token, tid) {
  let all = [], pt = '';
  do { const r = await api('GET', `/open-apis/bitable/v1/apps/${BASE}/tables/${tid}/records?page_size=500${pt ? '&page_token=' + pt : ''}`, token); (r.data?.items || []).forEach(x => all.push(x.record_id)); pt = r.data?.has_more ? r.data.page_token : ''; } while (pt);
  for (let i = 0; i < all.length; i += 500) await api('POST', `/open-apis/bitable/v1/apps/${BASE}/tables/${tid}/records/batch_delete`, token, { records: all.slice(i, i + 500) });
}

const FIELDS = [
  { field_name: '创意素材名称', type: 1 }, { field_name: '项目组', type: 1 }, { field_name: '评级', type: 1 },
  { field_name: '消耗', type: 2 }, { field_name: '广告首日ROI', type: 2 }, { field_name: '项目均ROI', type: 2 },
  { field_name: '近3日消耗', type: 2 }, { field_name: '日均消耗', type: 2 },
  { field_name: '点击率', type: 2 }, { field_name: 'CPM', type: 2 }, { field_name: '展示量', type: 2 },
  { field_name: '广告新增', type: 2 }, { field_name: '新增成本', type: 2 },
  { field_name: '在投天数', type: 2 }, { field_name: '首投日期', type: 5 },
];

async function main() {
  const token = await getFeishuToken();
  // TOBfe9: A序号 B按天1 C项目组2 D素材3 E消耗4 F_ROAS5 G活跃成本6 H展示7 I点击率8 J_CPM9
  const rows = await readRows(token, 'TOBfe9', 'A', 'K');
  const sers = rows.map(x => serAny(x[1])).filter(Boolean);
  if (!sers.length) { console.log('无数据'); return; }
  const maxS = Math.max(...sers), since = maxS - 29;

  const agg = {};  // 素材 → 统计
  rows.forEach(x => {
    const s = serAny(x[1]); if (!x[3] || !s || s < since || s > maxS) return;
    const sp = pnum(x[4]);
    const a = agg[x[3]] = agg[x[3]] || { grp: x[2] || '', sp: 0, rn: 0, imp: 0, clk: 0, cpmW: 0, first: s, last: s, days: new Set(), last3: 0, nu: 0 };
    a.sp += sp; a.rn += sp * ppct(x[5]); a.imp += pnum(x[7]); a.clk += pnum(x[7]) * ppct(x[8]); a.cpmW += sp;
    const cost = pnum(x[6]); if (cost > 0) a.nu += sp / cost;  // 广告新增 = 消耗/单价 反推
    a.first = Math.min(a.first, s); a.last = Math.max(a.last, s); a.days.add(s);
    if (s >= maxS - 2) a.last3 += sp;
  });
  // 项目内加权均 ROI(评级基准,分项目!)
  const proj = {};
  Object.values(agg).forEach(a => { const p = proj[a.grp] = proj[a.grp] || { sp: 0, rn: 0 }; p.sp += a.sp; p.rn += a.rn; });
  const projRoi = g => (proj[g] && proj[g].sp ? proj[g].rn / proj[g].sp : 0);

  const recs = Object.entries(agg).filter(([, a]) => a.sp > 0).map(([mat, a]) => {
    const roi = a.sp ? a.rn / a.sp : 0;
    const pAvg = projRoi(a.grp);
    const dayAvg = a.sp / Math.max(a.days.size, 1);
    const newbie = a.first >= maxS - 6;
    let grade;
    if (newbie) grade = '🆕新素材';
    else if (a.sp >= 30 && pAvg > 0 && roi <= pAvg * 0.5) grade = '🔴建议止损';
    else if (a.sp >= 50 && roi >= Math.max(pAvg * 1.2, pAvg + 0.1)) grade = '🌟放大复刻';
    else if (a.sp >= 30 && a.last3 / 3 < dayAvg * 0.5) grade = '⚠️衰退';
    else grade = '✅在投';
    return { sortKey: a.sp, fields: {
      '创意素材名称': mat, '项目组': a.grp, '评级': grade,
      '消耗': f1(a.sp), '广告首日ROI': f2(roi), '项目均ROI': f2(pAvg),
      '近3日消耗': f1(a.last3), '日均消耗': f1(dayAvg),
      '点击率': a.imp ? f2(a.clk / a.imp) : null, 'CPM': a.imp ? f1(a.sp / a.imp * 1000) : null,
      '展示量': Math.round(a.imp), '广告新增': Math.round(a.nu), '新增成本': a.nu ? f2(a.sp / a.nu) : null,
      '在投天数': a.days.size, '首投日期': (a.first - 25569) * 864e5,
    } };
  }).sort((a, b) => b.sortKey - a.sortKey).map(x => ({ fields: x.fields }));

  const tables = await listTables(token);
  let tid = tables.find(x => x.name === TABLE)?.table_id;
  if (tid) {
    await clearRecords(token, tid);
    const exist = new Set(((await api('GET', `/open-apis/bitable/v1/apps/${BASE}/tables/${tid}/fields?page_size=100`, token)).data?.items || []).map(x => x.field_name));
    for (const f of FIELDS) if (!exist.has(f.field_name)) await api('POST', `/open-apis/bitable/v1/apps/${BASE}/tables/${tid}/fields`, token, { field_name: f.field_name, type: f.type });
  }
  else tid = (await api('POST', `/open-apis/bitable/v1/apps/${BASE}/tables`, token, { table: { name: TABLE, fields: FIELDS } })).data?.table_id;
  for (let i = 0; i < recs.length; i += 200) { const w = await api('POST', `/open-apis/bitable/v1/apps/${BASE}/tables/${tid}/records/batch_create`, token, { records: recs.slice(i, i + 200) }); if (w.code !== 0) throw new Error('write: ' + JSON.stringify(w).slice(0, 120)); }

  // 按项目组维护筛选视图(投放同学按项目看)
  const fields = (await api('GET', `/open-apis/bitable/v1/apps/${BASE}/tables/${tid}/fields?page_size=50`, token)).data?.items || [];
  const fid = fields.find(x => x.field_name === '项目组')?.field_id;
  const views = (await api('GET', `/open-apis/bitable/v1/apps/${BASE}/tables/${tid}/views?page_size=100`, token)).data?.items || [];
  const have = new Set(views.map(v => v.view_name));
  const grps = [...new Set(recs.map(x => x.fields['项目组']).filter(Boolean))];
  for (const g of grps) {
    if (have.has(g)) continue;
    const cv = await api('POST', `/open-apis/bitable/v1/apps/${BASE}/tables/${tid}/views`, token, { view_name: g, view_type: 'grid' });
    if (cv.data?.view?.view_id) await api('PATCH', `/open-apis/bitable/v1/apps/${BASE}/tables/${tid}/views/${cv.data.view.view_id}`, token,
      { property: { filter_info: { conjunction: 'and', conditions: [{ field_id: fid, operator: 'is', value: JSON.stringify([g]) }] } } });
  }
  const stat = {};
  recs.forEach(x => { stat[x.fields['评级']] = (stat[x.fields['评级']] || 0) + 1; });
  console.log(`✅ 素材分析 ${recs.length} 条: ${Object.entries(stat).map(([k, v]) => k + v).join(' / ')}`);
}
if (require.main === module) main().catch(e => { console.error('ERR', e.message); process.exit(1); });
module.exports = { main };
