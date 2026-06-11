#!/usr/bin/env node
// 昨日速览 → 多维表 YB8TbS 三张快照表(总览/项目/包体),只装最新一天数据+环比前日。
// 仪表盘「📅 昨日速览」直接读全表(无需日期筛选),每天导入后自动滚动到新"昨日"。
// 注:最新一天产品收入 T+1 16点后才结算,收入状态列标注。
const https = require('https');
const { getFeishuToken } = require('./build-summaries');

const SS = 'J8mswO2vziyIAAkdt4rcVeaDnog';
const BASE = process.env.OVERVIEW_BASE || 'YB8TbS45kaO1gesMtqlc8kpznEb';

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
const serAny = s => {
  const str = String(s == null ? '' : s).trim();
  if (/^\d{5}(\.\d+)?$/.test(str)) return Math.round(+str);
  const m = /(\d{4})[/-](\d{1,2})[/-](\d{1,2})/.exec(str);
  return m ? Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 864e5) + 25569 : null;
};
const msOf = ser => (ser - 25569) * 864e5;
const f1 = v => Math.round(v * 10) / 10;
const f2 = v => Math.round(v * 100) / 100;
const chg = (cur, prev) => (prev ? f2((cur - prev) / prev) : null);

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
async function ensureTable(token, name, fields, tables) {
  const old = tables.find(x => x.name === name);
  if (old) {
    await clearRecords(token, old.table_id);
    const exist = new Set(((await api('GET', `/open-apis/bitable/v1/apps/${BASE}/tables/${old.table_id}/fields?page_size=100`, token)).data?.items || []).map(x => x.field_name));
    for (const f of fields) if (!exist.has(f.field_name)) await api('POST', `/open-apis/bitable/v1/apps/${BASE}/tables/${old.table_id}/fields`, token, { field_name: f.field_name, type: f.type });
    return old.table_id;
  }
  return (await api('POST', `/open-apis/bitable/v1/apps/${BASE}/tables`, token, { table: { name, fields } })).data?.table_id;
}
async function writeRecs(token, tid, recs) {
  for (let i = 0; i < recs.length; i += 200) { const w = await api('POST', `/open-apis/bitable/v1/apps/${BASE}/tables/${tid}/records/batch_create`, token, { records: recs.slice(i, i + 200) }); if (w.code !== 0) throw new Error('write: ' + JSON.stringify(w).slice(0, 120)); }
}

async function main() {
  const token = await getFeishuToken();
  const tables = await listTables(token);
  // 日经营 wAsSso: A日期 B消耗 C收入 D广告首日ROI E累计消耗 F累计收入 G累计ROI H新增
  const ws = (await readSheet(token, 'wAsSso!A2:H80')).filter(x => x[0] && serAny(x[0]))
    .map(x => ({ s: serAny(x[0]), sp: pnum(x[1]), rev: pnum(x[2]), roas: ppct(x[3]), cumROI: ppct(x[6]), nu: pnum(x[7]) }))
    .sort((a, b) => b.s - a.s);
  if (!ws.length) { console.log('无数据'); return; }
  // 出价维度(2zDzau): B按天0 C项目组1 D游戏2 E出价3 F消耗4 G_ROAS5 → serial|scope|bid 聚合
  const bidRows = (await readSheet(token, '2zDzau!B2:G300')).filter(x => x[0] && x[3]);
  const bidAgg = {};
  bidRows.forEach(x => {
    const s0 = serAny(x[0]); if (!s0) return;
    const sp = pnum(x[4]), rn = sp * ppct(x[5]);
    for (const scope of ['@ALL', 'G:' + (x[1] || ''), 'P:' + (x[2] || '')]) {
      const k = `${s0}|${scope}|${x[3]}`;
      const a = bidAgg[k] = bidAgg[k] || { sp: 0, rn: 0 };
      a.sp += sp; a.rn += rn;
    }
  });
  // 活跃度(kX0M0R 产品维度): B按天0 C项目组1 D游戏2 … H活跃度6 → serial|scope 聚合
  const actRows = (await readSheet(token, 'kX0M0R!B2:H300')).filter(x => x[0] && x[2]);
  const actAgg = {};
  actRows.forEach(x => {
    const s0 = serAny(x[0]); if (!s0) return;
    const act = pnum(x[6]);
    for (const scope of ['@ALL', 'G:' + (x[1] || ''), 'P:' + (x[2] || '')]) actAgg[`${s0}|${scope}`] = (actAgg[`${s0}|${scope}`] || 0) + act;
  });
  const actOf = (ser, scope, sp) => {
    const act = actAgg[`${ser}|${scope}`] || 0;
    return { '活跃度': act ? Math.round(act) : null, '活跃度平均成本': act && sp ? f2(sp / act) : null };
  };
  const bidOf = (ser, scope) => {
    const out = {};
    for (const [label, bid] of [['手动', '手动出价'], ['自动', '自动出价']]) {
      const a = bidAgg[`${ser}|${scope}|${bid}`];
      out[label + '出价消耗'] = a ? f1(a.sp) : null;
      out[label + '出价ROI'] = a && a.sp ? f2(a.rn / a.sp) : null;
    }
    return out;
  };
  const Y = ws[0], P = ws[1] || null;  // 昨日(最新有数据日) / 前日
  const W = ws.find(x => x.s === Y.s - 7) || null;  // 上周同天(同 weekday,公平对比)
  const pending = Y.rev <= 0 && Y.sp > 0;

  // ── 总览(1行) ──
  const ovT = await ensureTable(token, '昨日速览-总览', [
    { field_name: '日期', type: 5 }, { field_name: '消耗', type: 2 }, { field_name: '收入', type: 2 },
    { field_name: '广告首日ROI', type: 2 }, { field_name: '新增用户', type: 2 }, { field_name: '累计ROI', type: 2 },
    { field_name: '消耗环比', type: 2 }, { field_name: '收入环比', type: 2 },
    { field_name: '消耗环比上周同天', type: 2 }, { field_name: '收入环比上周同天', type: 2 },
    { field_name: '收入状态', type: 1 }, { field_name: '是否昨日', type: 1 },
    { field_name: '手动出价消耗', type: 2 }, { field_name: '手动出价ROI', type: 2 },
    { field_name: '自动出价消耗', type: 2 }, { field_name: '自动出价ROI', type: 2 },
    { field_name: '活跃度', type: 2 }, { field_name: '活跃度平均成本', type: 2 },
  ], tables);
  // 近 8 天每日一行(日期降序):指标卡 UI 可按"日期"字段开同环比(对比前一天/上周同天),
  // 预算环比列保留兼容现有卡。最新行收入未结算时标注。
  const ovRecs = ws.slice(0, 8).map((d, i) => {
    const p = ws[i + 1] || null, w = ws.find(x => x.s === d.s - 7) || null;
    const pend = d.rev <= 0 && d.sp > 0;
    return { fields: {
      '日期': msOf(d.s), '消耗': f1(d.sp), '收入': f1(d.rev), '广告首日ROI': f2(d.roas),
      '新增用户': Math.round(d.nu), '累计ROI': f2(d.cumROI),
      '消耗环比': p ? chg(d.sp, p.sp) : null, '收入环比': p && !pend ? chg(d.rev, p.rev) : null,
      '消耗环比上周同天': w ? chg(d.sp, w.sp) : null,
      '收入环比上周同天': w && !pend ? chg(d.rev, w.rev) : null,
      '收入状态': pend ? '待结算(16点后更新)' : '已结算',
      '是否昨日': i === 0 ? '是' : '',
      ...bidOf(d.s, '@ALL'), ...actOf(d.s, '@ALL', d.sp),
    } };
  });
  await writeRecs(token, ovT, ovRecs);

  // ── 项目维度(近8天 × 各组,支持指标卡按日期同环比) ── JIKPZV: B组 C日期 D消耗 E收入 F广告首日ROI ... I累计ROI
  const jk = (await readSheet(token, 'JIKPZV!B2:I500')).filter(x => x[0] && serAny(x[1]));
  const grpRow = (ser) => { const m = {}; jk.forEach(x => { if (serAny(x[1]) === ser) m[x[0]] = { sp: pnum(x[2]), rev: pnum(x[3]), roas: ppct(x[4]), cumROI: ppct(x[7]) }; }); return m; };
  const pjT = await ensureTable(token, '昨日速览-项目', [
    { field_name: '项目组', type: 1 }, { field_name: '日期', type: 5 }, { field_name: '消耗', type: 2 }, { field_name: '收入', type: 2 },
    { field_name: '广告首日ROI', type: 2 }, { field_name: '累计ROI', type: 2 }, { field_name: '消耗环比', type: 2 },
    { field_name: '是否昨日', type: 1 },
    { field_name: '手动出价消耗', type: 2 }, { field_name: '手动出价ROI', type: 2 },
    { field_name: '自动出价消耗', type: 2 }, { field_name: '自动出价ROI', type: 2 },
    { field_name: '活跃度', type: 2 }, { field_name: '活跃度平均成本', type: 2 },
  ], tables);
  const pjRecs = [];
  ws.slice(0, 8).forEach((d, i) => {
    const cur = grpRow(d.s), prev = ws[i + 1] ? grpRow(ws[i + 1].s) : {};
    Object.entries(cur).filter(([, v]) => v.sp > 0 || v.rev > 0)
      .sort((a, b) => b[1].sp - a[1].sp)
      .forEach(([g, v]) => pjRecs.push({ fields: { '项目组': g, '日期': msOf(d.s), '消耗': f1(v.sp), '收入': f1(v.rev),
        '广告首日ROI': f2(v.roas), '累计ROI': f2(v.cumROI), '消耗环比': prev[g] ? chg(v.sp, prev[g].sp) : null,
        '是否昨日': i === 0 ? '是' : '', ...bidOf(d.s, 'G:' + g), ...actOf(d.s, 'G:' + g, v.sp) } }));
  });
  await writeRecs(token, pjT, pjRecs);

  // ── 包体维度(近8天 × 各游戏) ── 6B1PVx: B统计周期1 C项目组2 D游戏3 E消耗4 F_ROAS5 G广告新增6 H新增成本7 K收入10
  const rp = (await readSheet(token, '6B1PVx!A2:V300')).filter(x => x[3] && serAny(x[1]));
  const gameRow = (ser) => { const m = {}; rp.forEach(x => { if (serAny(x[1]) === ser) m[x[3]] = { grp: x[2], sp: pnum(x[4]), roas: ppct(x[5]), adNew: pnum(x[6]), cost: pnum(x[7]), rev: pnum(x[10]) }; }); return m; };
  const pkT = await ensureTable(token, '昨日速览-包体', [
    { field_name: '游戏名称', type: 1 }, { field_name: '项目组', type: 1 }, { field_name: '日期', type: 5 }, { field_name: '消耗', type: 2 },
    { field_name: '广告新增', type: 2 }, { field_name: '广告新增成本', type: 2 }, { field_name: '广告首日ROI', type: 2 },
    { field_name: '收入', type: 2 }, { field_name: '消耗环比', type: 2 }, { field_name: '是否昨日', type: 1 },
    { field_name: '手动出价消耗', type: 2 }, { field_name: '手动出价ROI', type: 2 },
    { field_name: '自动出价消耗', type: 2 }, { field_name: '自动出价ROI', type: 2 },
    { field_name: '活跃度', type: 2 }, { field_name: '活跃度平均成本', type: 2 },
  ], tables);
  const pkRecs = [];
  ws.slice(0, 8).forEach((d, i) => {
    const cur = gameRow(d.s), prev = ws[i + 1] ? gameRow(ws[i + 1].s) : {};
    Object.entries(cur).filter(([, v]) => v.sp > 0)
      .sort((a, b) => b[1].sp - a[1].sp)
      .forEach(([g, v]) => pkRecs.push({ fields: { '游戏名称': g, '项目组': v.grp, '日期': msOf(d.s), '消耗': f1(v.sp),
        '广告新增': Math.round(v.adNew), '广告新增成本': f1(v.cost), '广告首日ROI': f2(v.roas), '收入': f1(v.rev),
        '消耗环比': prev[g] ? chg(v.sp, prev[g].sp) : null, '是否昨日': i === 0 ? '是' : '',
        ...bidOf(d.s, 'P:' + g), ...actOf(d.s, 'P:' + g, v.sp) } }));
  });
  await writeRecs(token, pkT, pkRecs);

  // ── 近30天-项目日消耗(驾驶舱多线趋势/占比用,窗口=最新日往前30天) ──
  const since = Y.s - 29;
  const r30T = await ensureTable(token, '近30天-项目日消耗', [
    { field_name: '项目组', type: 1 }, { field_name: '日期', type: 5 }, { field_name: '消耗', type: 2 },
  ], tables);
  const r30 = jk.filter(x => { const s = serAny(x[1]); return s >= since && s <= Y.s && pnum(x[2]) > 0; })
    .map(x => ({ fields: { '项目组': x[0], '日期': msOf(serAny(x[1])), '消耗': f1(pnum(x[2])) } }));
  await writeRecs(token, r30T, r30);

  // ── 近30天-出价方式(长格式:日×出价,供占比圆盘) + 近30天-出价日对比(宽格式:供4系列组合图) ──
  const bidSince = Y.s - 29;
  const bidLongT = await ensureTable(token, '近30天-出价方式', [
    { field_name: '日期', type: 5 }, { field_name: '出价方式', type: 1 },
    { field_name: '消耗', type: 2 }, { field_name: '广告首日ROI', type: 2 },
  ], tables);
  const bidWideT = await ensureTable(token, '近30天-出价日对比', [
    { field_name: '日期', type: 5 },
    { field_name: '手动出价消耗', type: 2 }, { field_name: '自动出价消耗', type: 2 },
    { field_name: '手动出价ROI', type: 2 }, { field_name: '自动出价ROI', type: 2 },
  ], tables);
  const longRecs = [], wideRecs = [];
  for (let s30 = bidSince; s30 <= Y.s; s30++) {
    const b = bidOf(s30, '@ALL');
    if (b['手动出价消耗'] == null && b['自动出价消耗'] == null) continue;
    for (const lb of ['手动', '自动']) {
      if (b[lb + '出价消耗'] == null) continue;
      longRecs.push({ fields: { '日期': msOf(s30), '出价方式': lb + '出价', '消耗': b[lb + '出价消耗'], '广告首日ROI': b[lb + '出价ROI'] } });
    }
    wideRecs.push({ fields: { '日期': msOf(s30), ...b } });
  }
  await writeRecs(token, bidLongT, longRecs);
  await writeRecs(token, bidWideT, wideRecs);

  console.log(`✅ 昨日速览: 总览${ovRecs.length}行 / 项目${pjRecs.length}行 / 包体${pkRecs.length}行 / 近30天项目${r30.length}行 / 出价${longRecs.length}+${wideRecs.length}行 (${new Date(msOf(Y.s)).toISOString().slice(0, 10)})`);
}
if (require.main === module) main().catch(e => { console.error('ERR', e.message); process.exit(1); });
module.exports = { main };
