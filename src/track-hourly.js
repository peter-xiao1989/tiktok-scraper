#!/usr/bin/env node
// 实时投放监测 v2:每小时把分时数据快照写入多维表,支撑 pacing 三线对比与异常预警。
// 方法论(docs/creative-analytics.md):
//   - pacing 对比基准:昨日同时点 + 近7日同时点均值(固定绝对阈值不可靠,一律相对偏离)
//   - 触发干预:消耗偏离基线 ±40%;ROI 连续3小时 < 7日同时段基线×0.7(单小时跳水不动作);断量
//   - 判读:超速且ROI达标=不动;超速且ROI低=降预算;断量=查审核/余额/出价
// 表:实时消耗时录(今日+近8日,含7日均合成行)/ 实时对比 / 实时预警 / 三张48h分时表。
// 由 realtime 流程每小时调用(sync-base fenshi 之后)。
const https = require('https');
const { getFeishuToken } = require('./build-summaries');

const SS = 'J8mswO2vziyIAAkdt4rcVeaDnog';
const BASE = process.env.OVERVIEW_BASE || 'YB8TbS45kaO1gesMtqlc8kpznEb';
const T_LOG = '实时消耗时录';
const T_CMP = '实时对比';
const T_ALERT = '实时预警';
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
const f1 = v => Math.round(v * 10) / 10;
const f2 = v => Math.round(v * 100) / 100;

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
async function batchDelete(token, tid, ids) {
  for (let i = 0; i < ids.length; i += 500) await api('POST', `/open-apis/bitable/v1/apps/${BASE}/tables/${tid}/records/batch_delete`, token, { records: ids.slice(i, i + 500) });
}
async function batchCreate(token, tid, recs) {
  for (let i = 0; i < recs.length; i += 200) await api('POST', `/open-apis/bitable/v1/apps/${BASE}/tables/${tid}/records/batch_create`, token, { records: recs.slice(i, i + 200) });
}

async function main() {
  const token = await getFeishuToken();
  const tables = await listTables(token);
  const now = new Date(Date.now() + 8 * 3600e3);  // 北京时间
  const hour = now.getUTCHours();
  const tagOf = d => `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const tag = tagOf(now);
  const ytag = tagOf(new Date(now.getTime() - 864e5));
  const keepTags = new Set();   // 今日+近8日(7日均的样本池)
  for (let i = 0; i <= 8; i++) keepTags.add(tagOf(new Date(now.getTime() - i * 864e5)));
  const AVG = '7日均';

  // 当前分时消耗(jdlBTh 明细行,项目组非空)
  const r = await api('GET', `/open-apis/sheets/v2/spreadsheets/${SS}/values/jdlBTh!C2:I40?valueRenderOption=FormattedValue`, token);
  const rows = (r.data?.valueRange?.values || []).filter(x => pnum(x[3]) > 0);  // C项目组0 D游戏1 E出价2 F消耗3 G_ROAS4 H活跃成本5 I活跃度6
  const ppct = v => { const str = String(v == null ? '' : v); return str.includes('%') ? pnum(str) / 100 : pnum(str); };
  const byGrp = {}; let total = 0, totalRn = 0, totalAct = 0;
  rows.forEach(x => { const sp = pnum(x[3]), rn = sp * ppct(x[4]);
    total += sp; totalRn += rn; totalAct += pnum(x[6]);
    if (x[0]) { const g = byGrp[x[0]] = byGrp[x[0]] || { sp: 0, rn: 0, act: 0 }; g.sp += sp; g.rn += rn; g.act += pnum(x[6]); } });

  // ── 实时消耗时录:今日+近8日累计快照 + 7日均合成行 ──────────────────────
  const logT = await ensureTable(token, T_LOG, [
    { field_name: '日期', type: 1 }, { field_name: '小时', type: 2 }, { field_name: '项目组', type: 1 },
    { field_name: '消耗', type: 2 }, { field_name: '本小时消耗', type: 2 }, { field_name: '广告首日ROI', type: 2 },
    { field_name: '活跃度', type: 2 }, { field_name: '活跃度平均成本', type: 2 },
    { field_name: '日标记', type: 1 }, { field_name: '记录时间', type: 5 },
  ], tables);
  let existing = await allRecords(token, logT);

  // 追加本小时快照(本小时消耗 = 当前累计 − 同日上一小时累计)
  const dup = existing.some(x => x.fields['日期'] === tag && String(x.fields['小时']) === String(hour) && x.fields['项目组'] === '全部');
  if (!dup) {
    const prevOf = grp => {
      const hs = existing.filter(x => x.fields['日期'] === tag && x.fields['项目组'] === grp && pnum(x.fields['小时']) < hour);
      if (!hs.length) return null;
      return hs.reduce((b, x) => (pnum(x.fields['小时']) > pnum(b.fields['小时']) ? x : b));
    };
    const mk = (grp, sp, rn, act) => {
      const prev = prevOf(grp);
      return { fields: { '日期': tag, '小时': hour, '项目组': grp,
        '消耗': f1(sp), '本小时消耗': prev ? Math.max(f1(sp - pnum(prev.fields['消耗'])), 0) : f1(sp),
        '广告首日ROI': sp ? f2(rn / sp) : null,
        '活跃度': Math.round(act), '活跃度平均成本': act ? f2(sp / act) : null,
        '日标记': '①今日', '记录时间': Date.now() } };
    };
    const recs = [mk('全部', total, totalRn, totalAct)];
    Object.entries(byGrp).forEach(([g, v]) => recs.push(mk(g, v.sp, v.rn, v.act)));
    await batchCreate(token, logT, recs);
    existing = existing.concat(recs.map(x => ({ fields: x.fields, record_id: null })));
  }

  // 清理:超出保留窗口的真实日 + 全部旧合成行(每小时重算)
  const stale = existing.filter(x => x.record_id && (x.fields['日期'] === AVG || !keepTags.has(x.fields['日期']))).map(x => x.record_id);
  await batchDelete(token, logT, stale);
  const real = existing.filter(x => x.fields['日期'] !== AVG && keepTags.has(x.fields['日期']));

  // 7日均合成行:每 (小时, 项目组) 对近7日(不含今日)同时点累计取均值(≥2天样本)
  const histDays = [...keepTags].filter(t => t !== tag);
  const avgRecs = [];
  const grpsAll = [...new Set(real.map(x => x.fields['项目组']))];
  for (const grp of grpsAll) {
    for (let h = 0; h < 24; h++) {
      const samples = histDays.map(d => real.find(x => x.fields['日期'] === d && String(x.fields['小时']) === String(h) && x.fields['项目组'] === grp)).filter(Boolean);
      if (samples.length < 2) continue;
      const m = f => samples.reduce((s, x) => s + pnum(x.fields[f]), 0) / samples.length;
      avgRecs.push({ fields: { '日期': AVG, '小时': h, '项目组': grp,
        '消耗': f1(m('消耗')), '本小时消耗': f1(m('本小时消耗')), '广告首日ROI': f2(m('广告首日ROI')),
        '活跃度': Math.round(m('活跃度')), '活跃度平均成本': f2(m('活跃度平均成本')),
        '日标记': '③7日均', '记录时间': Date.now() } });
    }
  }
  if (avgRecs.length) await batchCreate(token, logT, avgRecs);

  // 日标记维护(图表靠它筛三线:①今日/②昨日/③7日均;历史日留空)
  const fixes = real.filter(x => x.record_id).map(x => {
    const want = x.fields['日期'] === tag ? '①今日' : x.fields['日期'] === ytag ? '②昨日' : '';
    return (x.fields['日标记'] || '') !== want ? { record_id: x.record_id, fields: { '日标记': want } } : null;
  }).filter(Boolean);
  for (let i = 0; i < fixes.length; i += 200) await api('POST', `/open-apis/bitable/v1/apps/${BASE}/tables/${logT}/records/batch_update`, token, { records: fixes.slice(i, i + 200) });

  // 基准查表:昨日同时点 / 7日均同时点(找不到精确小时则取 ≤当前小时 最近一批)
  const atHour = (day, grp, h) => {
    const exact = real.find(x => x.fields['日期'] === day && String(x.fields['小时']) === String(h) && x.fields['项目组'] === grp);
    if (exact) return exact.fields;
    const before = real.filter(x => x.fields['日期'] === day && pnum(x.fields['小时']) <= h && x.fields['项目组'] === grp);
    return before.length ? before.reduce((b, x) => (pnum(x.fields['小时']) > pnum(b.fields['小时']) ? x : b)).fields : null;
  };
  const avgAt = (grp, h) => avgRecs.find(x => String(x.fields['小时']) === String(h) && x.fields['项目组'] === grp)?.fields || null;

  // ── 实时对比(快照矩阵:①今日 / ②昨日同时点 / ③7日均同时点)──────────────
  const cmpT = await ensureTable(token, T_CMP, [
    { field_name: '时点', type: 1 }, { field_name: '项目组', type: 1 }, { field_name: '消耗', type: 2 },
    { field_name: '广告首日ROI', type: 2 }, { field_name: '活跃度', type: 2 }, { field_name: '活跃度平均成本', type: 2 },
    { field_name: '同时段环比', type: 2 }, { field_name: '较7日均', type: 2 }, { field_name: '记录时间', type: 5 },
  ], tables);
  const oldCmp = await allRecords(token, cmpT);
  await batchDelete(token, cmpT, oldCmp.map(x => x.record_id));
  const cmpRecs = [];
  const pushCmp = (tp, grp, sp, roi, act, acost, vsY, vsA) => cmpRecs.push({ fields: { '时点': tp, '项目组': grp,
    '消耗': sp == null ? null : f1(sp), '广告首日ROI': roi ?? null,
    '活跃度': act == null ? null : Math.round(act), '活跃度平均成本': acost ?? null,
    '同时段环比': vsY ?? null, '较7日均': vsA ?? null, '记录时间': Date.now() } });
  const curOf = grp => grp === '全部'
    ? { sp: total, roi: total ? totalRn / total : null, act: totalAct, acost: totalAct ? total / totalAct : null }
    : { sp: byGrp[grp]?.sp || 0, roi: byGrp[grp]?.sp ? byGrp[grp].rn / byGrp[grp].sp : null, act: byGrp[grp]?.act || 0, acost: byGrp[grp]?.act ? byGrp[grp].sp / byGrp[grp].act : null };
  for (const grp of ['全部', ...Object.keys(byGrp)]) {
    const cur = curOf(grp);
    const y = atHour(ytag, grp, hour), a7 = avgAt(grp, hour);
    const ySp = y ? pnum(y['消耗']) : null, aSp = a7 ? pnum(a7['消耗']) : null;
    pushCmp('① 今日实时', grp, cur.sp, cur.roi != null ? f2(cur.roi) : null, cur.act, cur.acost != null ? f2(cur.acost) : null,
      ySp ? f2((cur.sp - ySp) / ySp) : null, aSp ? f2((cur.sp - aSp) / aSp) : null);
    if (y) pushCmp('② 昨日同时点', grp, ySp, y['广告首日ROI'] ?? null, y['活跃度'] ?? null, y['活跃度平均成本'] ?? null, null, null);
    if (a7) pushCmp('③ 7日均同时点', grp, aSp, a7['广告首日ROI'] ?? null, a7['活跃度'] ?? null, a7['活跃度平均成本'] ?? null, null, null);
  }
  await batchCreate(token, cmpT, cmpRecs);

  // ── 实时预警(每小时整表重算)────────────────────────────────────────────
  // 规则:消耗偏离基线±40% / ROI连续3h<7日基线×0.7 / 断量 / 游戏级 spike与高耗低回收
  const alertT = await ensureTable(token, T_ALERT, [
    { field_name: '级别', type: 1 }, { field_name: '类型', type: 1 }, { field_name: '对象', type: 1 },
    { field_name: '当前值', type: 2 }, { field_name: '基准值', type: 2 }, { field_name: '偏离', type: 2 },
    { field_name: '建议', type: 1 }, { field_name: '记录时间', type: 5 },
  ], tables);
  const oldAlert = await allRecords(token, alertT);
  await batchDelete(token, alertT, oldAlert.map(x => x.record_id));
  const alerts = [];
  const alert = (lvl, type, obj, cur, base, dev, sug) => alerts.push({ fields: {
    '级别': lvl, '类型': type, '对象': obj, '当前值': cur != null ? f2(cur) : null,
    '基准值': base != null ? f2(base) : null, '偏离': dev != null ? f2(dev) : null, '建议': sug, '记录时间': Date.now() } });

  for (const grp of ['全部', ...Object.keys(byGrp)]) {
    const cur = curOf(grp);
    const a7 = avgAt(grp, hour), y = atHour(ytag, grp, hour);
    const base = a7 ? pnum(a7['消耗']) : (y ? pnum(y['消耗']) : null);
    const baseRoi = a7 ? pnum(a7['广告首日ROI']) : (y ? pnum(y['广告首日ROI']) : null);
    const baseName = a7 ? '7日均' : '昨日';
    // 断量:基线有量,今日没量
    if (base != null && base >= 10 && cur.sp < 1) {
      alert('🔴', '断量', grp, cur.sp, base, -1, '查账户余额/审核状态/出价,确认是否被停');
      continue;
    }
    // 消耗偏离 ±40%
    if (base != null && base >= 5) {
      const dev = (cur.sp - base) / base;
      if (dev >= 0.4) {
        if (baseRoi > 0 && cur.roi != null && cur.roi < baseRoi * 0.7)
          alert('🔴', '超速且低效', grp, cur.sp, base, dev, `消耗超${baseName}同时点${Math.round(dev * 100)}%且ROI低于基线30%+,降预算`);
        else
          alert('🟡', '消耗超速', grp, cur.sp, base, dev, `超${baseName}同时点${Math.round(dev * 100)}%,ROI达标则不动,继续观察`);
      } else if (dev <= -0.4 && base >= 10) {
        alert('🟡', '消耗骤降', grp, cur.sp, base, dev, `低于${baseName}同时点${Math.round(-dev * 100)}%,查素材衰退/竞价环境`);
      }
    }
    // ROI 连续3小时低于7日同时段基线×0.7(单小时不动作)
    if (cur.sp >= 10) {
      const lows = [];
      for (let h = hour; h > hour - 3 && h >= 0; h--) {
        const t0 = atHour(tag, grp, h), b0 = avgAt(grp, h);
        if (!t0 || !b0 || b0['广告首日ROI'] == null) break;
        if (pnum(t0['广告首日ROI']) < pnum(b0['广告首日ROI']) * 0.7) lows.push(h); else break;
      }
      if (lows.length >= 3) {
        const b0 = avgAt(grp, hour);
        alert('🔴', 'ROI持续低迷', grp, cur.roi, b0 ? pnum(b0['广告首日ROI']) : null, null, '连续3小时低于7日同时段基线70%,排查素材/落地/出价');
      }
    }
  }
  // 游戏级(jdlBTh 当前快照 vs 分时明细昨日同时点)
  const detTid = tables.find(x => x.name === T_DET)?.table_id;
  const detAllPre = detTid ? await allRecords(token, detTid) : [];
  const gameY = {};   // 游戏 → 昨日同时点消耗
  detAllPre.filter(x => x.fields['日期'] === ytag && String(x.fields['小时']) === String(hour))
    .forEach(x => { const g = x.fields['游戏名称']; if (g) gameY[g] = (gameY[g] || 0) + pnum(x.fields['消耗']); });
  const gameCur = {};
  rows.forEach(x => { const g = x[1]; if (!g) return; const c = gameCur[g] = gameCur[g] || { sp: 0, rn: 0 }; c.sp += pnum(x[3]); c.rn += pnum(x[3]) * ppct(x[4]); });
  Object.entries(gameCur).forEach(([g, c]) => {
    const roi = c.sp ? c.rn / c.sp : 0;
    if (c.sp >= 10 && roi < 0.15) alert('🔴', '高耗低回收(游戏)', g, roi, 0.15, null, `今日已耗$${f1(c.sp)} ROI仅${f2(roi)},检查在投素材,必要时降量`);
    const yv = gameY[g];
    if (yv != null && yv >= 5 && c.sp >= 10 && c.sp >= yv * 2.5) alert('🟡', '消耗激增(游戏)', g, c.sp, yv, (c.sp - yv) / yv, 'ROI达标则放行,不达标降预算');
  });
  if (alerts.length) await batchCreate(token, alertT, alerts);

  // ── 投放分时明细(48h):每小时追加 jdlBTh 明细(项目×游戏×出价)──────────
  const detT = await ensureTable(token, T_DET, [
    { field_name: '记录时间', type: 5 }, { field_name: '日期', type: 1 }, { field_name: '小时', type: 2 },
    { field_name: '项目组', type: 1 }, { field_name: '游戏名称', type: 1 }, { field_name: '出价方式', type: 1 },
    { field_name: '消耗', type: 2 }, { field_name: '广告首日ROI', type: 2 }, { field_name: '活跃度平均成本', type: 2 },
  ], tables);
  const detAll = detTid ? detAllPre : await allRecords(token, detT);
  const cutoff = Date.now() - 48 * 3600e3;
  if (!detAll.some(x => x.fields['日期'] === tag && String(x.fields['小时']) === String(hour))) {
    const detRecs = rows.map(x => ({ fields: { '记录时间': Date.now(), '日期': tag, '小时': hour,
      '项目组': x[0], '游戏名称': x[1] || '', '出价方式': x[2] || '',
      '消耗': f1(pnum(x[3])), '广告首日ROI': f2(ppct(x[4])),
      '活跃度平均成本': f2(pnum(x[5])) } }));
    await batchCreate(token, detT, detRecs);
  }
  await batchDelete(token, detT, detAll.filter(x => (x.fields['记录时间'] || 0) < cutoff).map(x => x.record_id));

  // ── 投放分时总量(48h)──────────────────────────────────────────────────
  const totT = await ensureTable(token, T_TOT, [
    { field_name: '记录时间', type: 5 }, { field_name: '时点', type: 1 }, { field_name: '日期', type: 1 }, { field_name: '小时', type: 2 },
    { field_name: '消耗', type: 2 }, { field_name: '广告首日ROI', type: 2 }, { field_name: '活跃度平均成本', type: 2 },
  ], tables);
  const totAll = await allRecords(token, totT);
  if (!totAll.some(x => x.fields['日期'] === tag && String(x.fields['小时']) === String(hour))) {
    await batchCreate(token, totT, [{ fields: {
      '记录时间': Date.now(), '时点': `${tag} ${pad(hour)}时`, '日期': tag, '小时': hour,
      '消耗': f1(total), '广告首日ROI': total ? f2(totalRn / total) : null,
      '活跃度平均成本': totalAct ? f2(total / totalAct) : null } }]);
  }
  await batchDelete(token, totT, totAll.filter(x => (x.fields['记录时间'] || 0) < cutoff).map(x => x.record_id));

  // ── 投放分时项目明细(48h)──────────────────────────────────────────────
  const prjT = await ensureTable(token, T_PRJ, [
    { field_name: '记录时间', type: 5 }, { field_name: '时点', type: 1 }, { field_name: '日期', type: 1 }, { field_name: '小时', type: 2 },
    { field_name: '项目组', type: 1 }, { field_name: '消耗', type: 2 }, { field_name: '广告首日ROI', type: 2 }, { field_name: '活跃度平均成本', type: 2 },
  ], tables);
  const prjAll = await allRecords(token, prjT);
  if (!prjAll.some(x => x.fields['日期'] === tag && String(x.fields['小时']) === String(hour))) {
    const prjRecs = Object.entries(byGrp).map(([g, v]) => ({ fields: {
      '记录时间': Date.now(), '时点': `${tag} ${pad(hour)}时`, '日期': tag, '小时': hour, '项目组': g,
      '消耗': f1(v.sp), '广告首日ROI': v.sp ? f2(v.rn / v.sp) : null,
      '活跃度平均成本': v.act ? f2(v.sp / v.act) : null } }));
    if (prjRecs.length) await batchCreate(token, prjT, prjRecs);
  }
  await batchDelete(token, prjT, prjAll.filter(x => (x.fields['记录时间'] || 0) < cutoff).map(x => x.record_id));

  // 固化"记录时间"分钟级格式(幂等)
  for (const tid of [logT, cmpT, alertT, detT, totT, prjT]) {
    const fs2 = (await api('GET', `/open-apis/bitable/v1/apps/${BASE}/tables/${tid}/fields?page_size=20`, token)).data?.items || [];
    const f = fs2.find(x => x.field_name === '记录时间');
    if (f && f.property?.date_formatter !== 'yyyy/MM/dd HH:mm')
      await api('PUT', `/open-apis/base/v3/bases/${BASE}/tables/${tid}/fields/${f.field_id}`, token,
        { name: '记录时间', type: 'datetime', style: { format: 'yyyy/MM/dd HH:mm' } });
  }
  console.log(`✅ 时录v2 ${tag} ${hour}点 总消耗${f1(total)} 预警${alerts.length}条(7日均样本${avgRecs.length}行)`);
}
if (require.main === module) main().catch(e => { console.error('ERR', e.message); process.exit(1); });
module.exports = { main };
