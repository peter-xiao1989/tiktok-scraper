#!/usr/bin/env node
// 实时消耗时录:每小时把分时数据快照追加到多维表(不覆盖),实现"今天 H 点 vs
// 昨天 H 点"同时段对比。表只保留今昨两天(图表天然双线对比,无需日期筛选)。
// 由 realtime 流程每小时调用(sync-base fenshi 之后)。
const https = require('https');
const { getFeishuToken } = require('./build-summaries');

const SS = 'J8mswO2vziyIAAkdt4rcVeaDnog';
const BASE = process.env.OVERVIEW_BASE || 'YB8TbS45kaO1gesMtqlc8kpznEb';
const T_LOG = '实时消耗时录';
const T_CMP = '实时对比';
const T_DET = '投放分时明细(48h)';
const T_TOT = '投放分时总量(48h)';
const T_PRJ = '投放分时项目明细(48h)';

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
const pad = n => String(n).padStart(2, '0');

async function listTables(token) { return (await api('GET', `/open-apis/bitable/v1/apps/${BASE}/tables?page_size=100`, token)).data?.items || []; }
async function allRecords(token, tid) {
  let all = [], pt = '';
  do { const r = await api('GET', `/open-apis/bitable/v1/apps/${BASE}/tables/${tid}/records?page_size=500${pt ? '&page_token=' + pt : ''}`, token); (r.data?.items || []).forEach(x => all.push(x)); pt = r.data?.has_more ? r.data.page_token : ''; } while (pt);
  return all;
}
async function ensureTable(token, name, fields, tables) {
  const old = tables.find(x => x.name === name);
  if (old) {
    const exist = new Set(((await api('GET', `/open-apis/bitable/v1/apps/${BASE}/tables/${old.table_id}/fields?page_size=100`, token)).data?.items || []).map(x => x.field_name));
    for (const f of fields) if (!exist.has(f.field_name)) await api('POST', `/open-apis/bitable/v1/apps/${BASE}/tables/${old.table_id}/fields`, token, { field_name: f.field_name, type: f.type });
    return old.table_id;
  }
  return (await api('POST', `/open-apis/bitable/v1/apps/${BASE}/tables`, token, { table: { name, fields } })).data?.table_id;
}

async function main() {
  const token = await getFeishuToken();
  const tables = await listTables(token);
  const now = new Date(Date.now() + 8 * 3600e3);  // 北京时间
  const hour = now.getUTCHours();
  const tag = `${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`;
  const yd = new Date(now.getTime() - 864e5);
  const ytag = `${pad(yd.getUTCMonth() + 1)}-${pad(yd.getUTCDate())}`;

  // 当前分时消耗(jdlBTh 明细行,项目组非空)
  const r = await api('GET', `/open-apis/sheets/v2/spreadsheets/${SS}/values/jdlBTh!C2:I40?valueRenderOption=FormattedValue`, token);
  const rows = (r.data?.valueRange?.values || []).filter(x => x[0]);  // C项目组0 D游戏1 E出价2 F消耗3 G_ROAS4 H活跃成本5 I活跃度6
  const ppct = v => { const str = String(v == null ? '' : v); return str.includes('%') ? pnum(str) / 100 : pnum(str); };
  const byGrp = {}; let total = 0, totalRn = 0, totalAct = 0;
  rows.forEach(x => { const sp = pnum(x[3]), rn = sp * ppct(x[4]);
    const g = byGrp[x[0]] = byGrp[x[0]] || { sp: 0, rn: 0, act: 0 }; g.sp += sp; g.rn += rn; g.act += pnum(x[6]); total += sp; totalRn += rn; totalAct += pnum(x[6]); });

  const logT = await ensureTable(token, T_LOG, [
    { field_name: '日期', type: 1 }, { field_name: '小时', type: 2 }, { field_name: '项目组', type: 1 },
    { field_name: '消耗', type: 2 }, { field_name: '广告首日ROI', type: 2 },
    { field_name: '活跃度', type: 2 }, { field_name: '活跃度平均成本', type: 2 }, { field_name: '记录时间', type: 5 },
  ], tables);
  const existing = await allRecords(token, logT);
  // 同日同小时已记过(workflow 兜底重复触发)则跳过追加
  const dup = existing.some(x => x.fields['日期'] === tag && String(x.fields['小时']) === String(hour) && x.fields['项目组'] === '全部');
  if (!dup) {
    const recs = [{ fields: { '日期': tag, '小时': hour, '项目组': '全部', '消耗': Math.round(total * 10) / 10, '广告首日ROI': total ? Math.round(totalRn / total * 100) / 100 : null,
      '活跃度': Math.round(totalAct), '活跃度平均成本': totalAct ? Math.round(total / totalAct * 100) / 100 : null, '记录时间': Date.now() } }];
    Object.entries(byGrp).forEach(([g, v]) => recs.push({ fields: { '日期': tag, '小时': hour, '项目组': g, '消耗': Math.round(v.sp * 10) / 10, '广告首日ROI': v.sp ? Math.round(v.rn / v.sp * 100) / 100 : null,
      '活跃度': Math.round(v.act), '活跃度平均成本': v.act ? Math.round(v.sp / v.act * 100) / 100 : null, '记录时间': Date.now() } }));
    await api('POST', `/open-apis/bitable/v1/apps/${BASE}/tables/${logT}/records/batch_create`, token, { records: recs });
  }
  // 清理今昨之外的旧记录(表只留两天 → 折线图天然 今天vs昨天 双线)
  const stale = existing.filter(x => x.fields['日期'] !== tag && x.fields['日期'] !== ytag).map(x => x.record_id);
  for (let i = 0; i < stale.length; i += 500) await api('POST', `/open-apis/bitable/v1/apps/${BASE}/tables/${logT}/records/batch_delete`, token, { records: stale.slice(i, i + 500) });

  // 同时段对比(时点×项目组 矩阵):昨天同小时(找不到则取昨天 ≤当前小时 最近一批)
  const yAll = existing.filter(x => x.fields['日期'] === ytag);
  let yHour = yAll.some(x => String(x.fields['小时']) === String(hour)) ? hour
    : Math.max(...yAll.filter(x => x.fields['小时'] <= hour).map(x => x.fields['小时']), -1);
  const yBy = {};  // 项目组 → {sp, roi}(昨日同时段)
  yAll.filter(x => String(x.fields['小时']) === String(yHour)).forEach(x => { yBy[x.fields['项目组']] = { sp: pnum(x.fields['消耗']), roi: x.fields['广告首日ROI'] ?? null, act: x.fields['活跃度'] ?? null, acost: x.fields['活跃度平均成本'] ?? null }; });
  const ySpend = yBy['全部'] ? yBy['全部'].sp : null;
  const cmpT = await ensureTable(token, T_CMP, [
    { field_name: '时点', type: 1 }, { field_name: '项目组', type: 1 }, { field_name: '消耗', type: 2 },
    { field_name: '广告首日ROI', type: 2 }, { field_name: '活跃度', type: 2 }, { field_name: '活跃度平均成本', type: 2 },
    { field_name: '同时段环比', type: 2 }, { field_name: '记录时间', type: 5 },
  ], tables);
  const old = await allRecords(token, cmpT);
  if (old.length) await api('POST', `/open-apis/bitable/v1/apps/${BASE}/tables/${cmpT}/records/batch_delete`, token, { records: old.map(x => x.record_id) });
  const cmpRecs = [];
  const push = (tp, grp, sp, roi, act, acost, chgV) => cmpRecs.push({ fields: { '时点': tp, '项目组': grp,
    '消耗': sp == null ? null : Math.round(sp * 10) / 10, '广告首日ROI': roi ?? null,
    '活跃度': act == null ? null : Math.round(act), '活跃度平均成本': acost ?? null,
    '同时段环比': chgV ?? null, '记录时间': Date.now() } });
  push('① 今日实时', '全部', total, total ? Math.round(totalRn / total * 100) / 100 : null,
    totalAct, totalAct ? Math.round(total / totalAct * 100) / 100 : null,
    ySpend ? Math.round((total - ySpend) / ySpend * 100) / 100 : null);
  Object.entries(byGrp).forEach(([g, v]) => push('① 今日实时', g, v.sp, v.sp ? Math.round(v.rn / v.sp * 100) / 100 : null,
    v.act, v.act ? Math.round(v.sp / v.act * 100) / 100 : null,
    yBy[g] && yBy[g].sp ? Math.round((v.sp - yBy[g].sp) / yBy[g].sp * 100) / 100 : null));
  Object.entries(yBy).forEach(([g, v]) => push('② 昨日同时段', g, v.sp, v.roi, v.act, v.acost, null));
  await api('POST', `/open-apis/bitable/v1/apps/${BASE}/tables/${cmpT}/records/batch_create`, token, { records: cmpRecs });
  // ── 投放分时明细(48h):每小时追加 jdlBTh 明细(项目×游戏×出价),保留近48小时 ──
  const detT = await ensureTable(token, T_DET, [
    { field_name: '记录时间', type: 5 }, { field_name: '日期', type: 1 }, { field_name: '小时', type: 2 },
    { field_name: '项目组', type: 1 }, { field_name: '游戏名称', type: 1 }, { field_name: '出价方式', type: 1 },
    { field_name: '消耗', type: 2 }, { field_name: '广告首日ROI', type: 2 }, { field_name: '活跃度平均成本', type: 2 },
  ], tables);
  const detAll = await allRecords(token, detT);
  const cutoff = Date.now() - 48 * 3600e3;
  if (!detAll.some(x => x.fields['日期'] === tag && String(x.fields['小时']) === String(hour))) {
    const detRecs = rows.map(x => ({ fields: { '记录时间': Date.now(), '日期': tag, '小时': hour,
      '项目组': x[0], '游戏名称': x[1] || '', '出价方式': x[2] || '',
      '消耗': Math.round(pnum(x[3]) * 10) / 10, '广告首日ROI': Math.round(ppct(x[4]) * 100) / 100,
      '活跃度平均成本': Math.round(pnum(x[5]) * 100) / 100 } }));
    for (let i = 0; i < detRecs.length; i += 200) await api('POST', `/open-apis/bitable/v1/apps/${BASE}/tables/${detT}/records/batch_create`, token, { records: detRecs.slice(i, i + 200) });
  }
  const detStale = detAll.filter(x => (x.fields['记录时间'] || 0) < cutoff).map(x => x.record_id);
  for (let i = 0; i < detStale.length; i += 500) await api('POST', `/open-apis/bitable/v1/apps/${BASE}/tables/${detT}/records/batch_delete`, token, { records: detStale.slice(i, i + 500) });

  // ── 投放分时总量(48h):每小时一行,不分项目/游戏 ──
  const totT = await ensureTable(token, T_TOT, [
    { field_name: '记录时间', type: 5 }, { field_name: '时点', type: 1 }, { field_name: '日期', type: 1 }, { field_name: '小时', type: 2 },
    { field_name: '消耗', type: 2 }, { field_name: '广告首日ROI', type: 2 }, { field_name: '活跃度平均成本', type: 2 },
  ], tables);
  const totAll = await allRecords(token, totT);
  if (!totAll.some(x => x.fields['日期'] === tag && String(x.fields['小时']) === String(hour))) {
    await api('POST', `/open-apis/bitable/v1/apps/${BASE}/tables/${totT}/records/batch_create`, token, { records: [{ fields: {
      '记录时间': Date.now(), '时点': `${tag} ${pad(hour)}时`, '日期': tag, '小时': hour,
      '消耗': Math.round(total * 10) / 10, '广告首日ROI': total ? Math.round(totalRn / total * 100) / 100 : null,
      '活跃度平均成本': totalAct ? Math.round(total / totalAct * 100) / 100 : null } }] });
  }
  const totStale = totAll.filter(x => (x.fields['记录时间'] || 0) < cutoff).map(x => x.record_id);
  for (let i = 0; i < totStale.length; i += 500) await api('POST', `/open-apis/bitable/v1/apps/${BASE}/tables/${totT}/records/batch_delete`, token, { records: totStale.slice(i, i + 500) });

  // ── 投放分时项目明细(48h):每小时 × 每项目组一行(不分游戏/出价) ──
  const prjT = await ensureTable(token, T_PRJ, [
    { field_name: '记录时间', type: 5 }, { field_name: '时点', type: 1 }, { field_name: '日期', type: 1 }, { field_name: '小时', type: 2 },
    { field_name: '项目组', type: 1 }, { field_name: '消耗', type: 2 }, { field_name: '广告首日ROI', type: 2 }, { field_name: '活跃度平均成本', type: 2 },
  ], tables);
  const prjAll = await allRecords(token, prjT);
  if (!prjAll.some(x => x.fields['日期'] === tag && String(x.fields['小时']) === String(hour))) {
    const prjRecs = Object.entries(byGrp).map(([g, v]) => ({ fields: {
      '记录时间': Date.now(), '时点': `${tag} ${pad(hour)}时`, '日期': tag, '小时': hour, '项目组': g,
      '消耗': Math.round(v.sp * 10) / 10, '广告首日ROI': v.sp ? Math.round(v.rn / v.sp * 100) / 100 : null,
      '活跃度平均成本': v.act ? Math.round(v.sp / v.act * 100) / 100 : null } }));
    if (prjRecs.length) await api('POST', `/open-apis/bitable/v1/apps/${BASE}/tables/${prjT}/records/batch_create`, token, { records: prjRecs });
  }
  const prjStale = prjAll.filter(x => (x.fields['记录时间'] || 0) < cutoff).map(x => x.record_id);
  for (let i = 0; i < prjStale.length; i += 500) await api('POST', `/open-apis/bitable/v1/apps/${BASE}/tables/${prjT}/records/batch_delete`, token, { records: prjStale.slice(i, i + 500) });

  // 固化"记录时间"分钟级格式(表若被重建,字段默认只显示天;幂等,无变化时服务端忽略)
  for (const tid of [logT, cmpT, detT, totT, prjT]) {
    const fs2 = (await api('GET', `/open-apis/bitable/v1/apps/${BASE}/tables/${tid}/fields?page_size=20`, token)).data?.items || [];
    const f2 = fs2.find(x => x.field_name === '记录时间');
    if (f2 && f2.property?.date_formatter !== 'yyyy/MM/dd HH:mm')
      await api('PUT', `/open-apis/base/v3/bases/${BASE}/tables/${tid}/fields/${f2.field_id}`, token,
        { name: '记录时间', type: 'datetime', style: { format: 'yyyy/MM/dd HH:mm' } });
  }
  console.log(`✅ 时录 ${tag} ${hour}点 总消耗${Math.round(total * 10) / 10}${ySpend != null ? ` vs 昨日同时段${ySpend}` : '(昨日无记录,明日起有对比)'}`);
}
if (require.main === module) main().catch(e => { console.error('ERR', e.message); process.exit(1); });
module.exports = { main };
