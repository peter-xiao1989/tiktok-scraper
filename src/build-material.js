#!/usr/bin/env node
// 素材分析 v2(近30天)——方法论驱动的素材决策系统,从投放原表(ad级)直接聚合。
//
// 方法论依据(2026-06 调研,来源见 docs/creative-analytics.md):
//   漏斗:曝光 → 6s互动观看(EVR,hook proxy) → 点击(CTR) → 安装(CVR/IPM) → 游戏新增(首启率) → 回收(首日ROI/D6爬坡)
//   生命周期:🧪测试中 → 🚀机会(winner,加量) → 🌟主力(scaling) → ⚠️疲劳(Refresh/Replace) → 🔴止损(kill)
//   判定原则:相对基准(项目中位数/自身峰值7日窗口)优于绝对阈值;双门槛(消耗+曝光/安装数)防假winner;
//   疲劳衰减顺序 CTR先掉→CPM涨→CVR乱→ROAS最后崩,等ROAS掉已晚 → 以CTR/IPM/CPM为先导信号。
//   干预三档:Watch(1信号,备替补不动) / Refresh(2+信号或ROI跌30%,减预算50%+上迭代) / Replace(CTR较峰值-40%,立即停)。
//
// 产出 3 张表:素材分析(近30天) / 素材日趋势(近30天) / 素材漏斗(近30天)
const https = require('https');
const { getFeishuToken, getGroupMapping, EXTRA_GROUP_MAP } = require('./build-summaries');

const SS = 'J8mswO2vziyIAAkdt4rcVeaDnog';
const BASE = process.env.OVERVIEW_BASE || 'YB8TbS45kaO1gesMtqlc8kpznEb';
const T_MAIN = '素材分析(近30天)';
const T_DAY = '素材日趋势(近30天)';
const T_FUN = '素材漏斗(近30天)';

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
const f4 = v => Math.round(v * 10000) / 10000;
const msOf = ser => (ser - 25569) * 864e5;
const median = arr => { const a = [...arr].sort((x, y) => x - y); return a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : 0; };

async function readRows(token, sheet, a, b) {
  let out = [], s = 2;
  while (s < 500000) { const r = await api('GET', `/open-apis/sheets/v2/spreadsheets/${SS}/values/${sheet}!${a}${s}:${b}${s + 999}?valueRenderOption=FormattedValue`, token); const rows = r.data?.valueRange?.values || []; if (!rows.length) break; out = out.concat(rows); if (rows.length < 1000) break; s += 1000; }
  return out;
}
async function listTables(token) { return (await api('GET', `/open-apis/bitable/v1/apps/${BASE}/tables?page_size=100`, token)).data?.items || []; }
async function clearRecords(token, tid) {
  let all = [], pt = '';
  do { const r = await api('GET', `/open-apis/bitable/v1/apps/${BASE}/tables/${tid}/records?page_size=500${pt ? '&page_token=' + pt : ''}`, token); (r.data?.items || []).forEach(x => all.push(x.record_id)); pt = r.data?.has_more ? r.data.page_token : ''; } while (pt);
  for (let i = 0; i < all.length; i += 500) await api('POST', `/open-apis/bitable/v1/apps/${BASE}/tables/${tid}/records/batch_delete`, token, { records: all.slice(i, i + 500) });
}
async function ensureTable(token, tables, name, FIELDS) {
  let tid = tables.find(x => x.name === name)?.table_id;
  if (tid) {
    await clearRecords(token, tid);
    const exist = new Set(((await api('GET', `/open-apis/bitable/v1/apps/${BASE}/tables/${tid}/fields?page_size=100`, token)).data?.items || []).map(x => x.field_name));
    for (const f of FIELDS) if (!exist.has(f.field_name)) await api('POST', `/open-apis/bitable/v1/apps/${BASE}/tables/${tid}/fields`, token, { field_name: f.field_name, type: f.type });
  } else tid = (await api('POST', `/open-apis/bitable/v1/apps/${BASE}/tables`, token, { table: { name, fields: FIELDS } })).data?.table_id;
  return tid;
}
async function writeRecs(token, tid, recs) {
  for (let i = 0; i < recs.length; i += 200) { const w = await api('POST', `/open-apis/bitable/v1/apps/${BASE}/tables/${tid}/records/batch_create`, token, { records: recs.slice(i, i + 200) }); if (w.code !== 0) throw new Error('write: ' + JSON.stringify(w).slice(0, 120)); }
}

const MAIN_FIELDS = [
  { field_name: '创意素材名称', type: 1 }, { field_name: '项目组', type: 1 }, { field_name: '主投游戏', type: 1 },
  { field_name: '评级', type: 1 }, { field_name: '评级依据', type: 1 }, { field_name: '建议动作', type: 1 },
  { field_name: '疲劳信号', type: 1 }, { field_name: '是否新素材', type: 1 }, { field_name: 'Top素材', type: 1 },
  { field_name: '消耗', type: 2 }, { field_name: '项目消耗占比', type: 2 },
  { field_name: '广告首日ROI', type: 2 }, { field_name: '项目中位ROI', type: 2 }, { field_name: 'D6回本倍数', type: 2 },
  { field_name: '吸睛率EVR', type: 2 }, { field_name: '点击率', type: 2 }, { field_name: '安装转化率CVR', type: 2 },
  { field_name: 'IPM', type: 2 }, { field_name: '项目中位IPM', type: 2 }, { field_name: 'CPI', type: 2 },
  { field_name: '首启率', type: 2 }, { field_name: '广告新增', type: 2 }, { field_name: '新增成本', type: 2 },
  { field_name: 'CPM', type: 2 }, { field_name: 'CPC', type: 2 }, { field_name: '展示量', type: 2 }, { field_name: '安装数', type: 2 },
  { field_name: '近3日CTR较峰值', type: 2 }, { field_name: '近3日IPM较峰值', type: 2 },
  { field_name: '近3日CPM较前期', type: 2 }, { field_name: '近3日ROI较峰值', type: 2 },
  { field_name: '近3日消耗', type: 2 }, { field_name: '日均消耗', type: 2 },
  { field_name: '在投天数', type: 2 }, { field_name: '首投日期', type: 5 }, { field_name: '末投日期', type: 5 },
];
const DAY_FIELDS = [
  { field_name: '日期', type: 5 }, { field_name: '创意素材名称', type: 1 }, { field_name: '项目组', type: 1 },
  { field_name: '消耗', type: 2 }, { field_name: '点击率', type: 2 }, { field_name: 'CPM', type: 2 },
  { field_name: '广告首日ROI', type: 2 }, { field_name: 'IPM', type: 2 }, { field_name: 'Top素材', type: 1 },
  { field_name: '是否新素材', type: 1 },
];
const FUN_FIELDS = [
  { field_name: '项目组', type: 1 }, { field_name: '阶段', type: 1 }, { field_name: '数值', type: 2 },
  { field_name: '转化率(上级)', type: 2 },
];

async function main() {
  const token = await getFeishuToken();
  const { gameToGroup } = await getGroupMapping(token);
  const g2g = { ...gameToGroup, ...(EXTRA_GROUP_MAP || {}) };

  // 投放原表 B..AT(0-based from B):0游戏 2按天 3消耗 4ROAS 5活跃度 11素材
  // 20安装V 22点击X 23展示Y 27曝光事件率AC 38d0收入AN 39d6收入AO
  const rows = await readRows(token, 'uqJEhq', 'B', 'AT');
  const sers = rows.map(x => serAny(x[2])).filter(Boolean);
  if (!sers.length) { console.log('无数据'); return; }
  const maxS = Math.max(...sers), since = maxS - 29;

  const agg = {};   // 项目组|素材 → 汇总 + 日序列
  rows.forEach(x => {
    const s = serAny(x[2]); const mat = x[11];
    if (!mat || !s || s < since || s > maxS) return;
    const game = x[0] || '';
    const grp = g2g[game] || '其他';
    const sp = pnum(x[3]);
    const imp = pnum(x[23]), clk = pnum(x[22]), inst = pnum(x[20]);
    const ev = imp * ppct(x[27]);                      // 6s互动观看数 = 展示×曝光事件率
    const rn = sp * ppct(x[4]);                        // 首日ROI口径收入(与全站一致)
    const k = `${grp}|${mat}`;
    const a = agg[k] = agg[k] || { mat, grp, games: {}, sp: 0, rn: 0, imp: 0, clk: 0, inst: 0, ev: 0, nu: 0,
      d0m: 0, d6m: 0, first: s, last: s, days: new Set(), daily: {} };
    a.sp += sp; a.rn += rn; a.imp += imp; a.clk += clk; a.inst += inst; a.ev += ev; a.nu += pnum(x[5]);
    a.games[game] = (a.games[game] || 0) + sp;
    if (s <= maxS - 6) { a.d0m += pnum(x[38]); a.d6m += pnum(x[39]); }   // D6爬坡只用已成熟日
    a.first = Math.min(a.first, s); a.last = Math.max(a.last, s); a.days.add(s);
    const d = a.daily[s] = a.daily[s] || { sp: 0, rn: 0, imp: 0, clk: 0, inst: 0 };
    d.sp += sp; d.rn += rn; d.imp += imp; d.clk += clk; d.inst += inst;
  });

  // 项目基准:加权均(展示用) + 中位数(判定用,只取有效样本 sp≥10 的素材)
  const proj = {};
  Object.values(agg).forEach(a => {
    const p = proj[a.grp] = proj[a.grp] || { sp: 0, rn: 0, imp: 0, clk: 0, inst: 0, ev: 0, nu: 0, rois: [], ipms: [], ctrs: [], cpis: [] };
    p.sp += a.sp; p.rn += a.rn; p.imp += a.imp; p.clk += a.clk; p.inst += a.inst; p.ev += a.ev; p.nu += a.nu;
    if (a.sp >= 10 && a.imp >= 1000) {
      p.rois.push(a.sp ? a.rn / a.sp : 0);
      p.ipms.push(a.imp ? a.inst / a.imp * 1000 : 0);
      p.ctrs.push(a.imp ? a.clk / a.imp : 0);
      if (a.inst >= 3) p.cpis.push(a.sp / a.inst);
    }
  });
  const med = (g, f) => median(proj[g]?.[f] || []);

  // 自身峰值基线(7日滚动窗口最优值)+ 近3日:疲劳检测核心
  const baselineOf = a => {
    const days = [...a.days].sort((x, y) => x - y);
    const win = endIdx => {       // 以 days[endIdx] 结尾、跨度≤7天的窗口聚合
      const end = days[endIdx], t = { sp: 0, imp: 0, clk: 0, inst: 0, rn: 0 };
      for (let i = endIdx; i >= 0 && days[i] > end - 7; i--) {
        const d = a.daily[days[i]];
        t.sp += d.sp; t.imp += d.imp; t.clk += d.clk; t.inst += d.inst; t.rn += d.rn;
      }
      return t;
    };
    let ctrB = null, ipmB = null, roiB = null;
    for (let i = 0; i < days.length; i++) {
      if (days[i] > maxS - 3) break;            // 峰值窗口不含近3日
      const w = win(i);
      if (w.imp >= 500) ctrB = Math.max(ctrB ?? 0, w.clk / w.imp);
      if (w.imp >= 500 && w.inst >= 5) ipmB = Math.max(ipmB ?? 0, w.inst / w.imp * 1000);
      if (w.sp >= 10) roiB = Math.max(roiB ?? 0, w.rn / w.sp);
    }
    const L = { sp: 0, imp: 0, clk: 0, inst: 0, rn: 0 };   // 近3日
    let prior = { sp: 0, imp: 0 };                          // 前期(CPM基线)
    Object.entries(a.daily).forEach(([s, d]) => {
      if (+s >= maxS - 2) { L.sp += d.sp; L.imp += d.imp; L.clk += d.clk; L.inst += d.inst; L.rn += d.rn; }
      else { prior.sp += d.sp; prior.imp += d.imp; }
    });
    return { ctrB, ipmB, roiB, cpmB: prior.imp >= 500 ? prior.sp / prior.imp * 1000 : null, L };
  };

  // ── 评级 ─────────────────────────────────────────────────────────────────
  const mainRecs = [];
  const topByProj = {};   // 项目 → 消耗Top5(图表筛选用)
  Object.values(agg).filter(a => a.sp > 0).sort((x, y) => y.sp - x.sp).forEach(a => {
    const t = topByProj[a.grp] = topByProj[a.grp] || [];
    if (t.length < 5 && a.sp >= 10) t.push(a.mat);
  });
  Object.values(agg).filter(a => a.sp > 0).forEach(a => {
    const roi = a.sp ? a.rn / a.sp : 0;
    const ctr = a.imp ? a.clk / a.imp : 0;
    const ipm = a.imp ? a.inst / a.imp * 1000 : 0;
    const evr = a.imp ? a.ev / a.imp : 0;
    const cvr = a.clk ? a.inst / a.clk : 0;
    const cpi = a.inst ? a.sp / a.inst : null;
    const dayAvg = a.sp / Math.max(a.days.size, 1);
    const roiMed = med(a.grp, 'rois'), ipmMed = med(a.grp, 'ipms'), ctrMed = med(a.grp, 'ctrs'), cpiMed = med(a.grp, 'cpis');
    const d6x = a.d0m > 0 ? a.d6m / a.d0m : null;
    const B = baselineOf(a);
    const pc = v => `${v >= 0 ? '+' : ''}${Math.round(v * 100)}%`;

    // 疲劳信号(相对自身峰值/前期;近3日样本足够才判)
    const sigs = [];
    let dCtr = null, dIpm = null, dCpm = null, dRoi = null;
    if (B.L.imp >= 500) {
      if (B.ctrB > 0) { dCtr = (B.L.clk / B.L.imp - B.ctrB) / B.ctrB; if (dCtr <= -0.2) sigs.push(`CTR较峰值${pc(dCtr)}`); }
      if (B.ipmB > 0 && B.L.inst >= 3) { dIpm = (B.L.inst / B.L.imp * 1000 - B.ipmB) / B.ipmB; if (dIpm <= -0.25) sigs.push(`IPM较峰值${pc(dIpm)}`); }
      if (B.cpmB > 0) { dCpm = (B.L.sp / B.L.imp * 1000 - B.cpmB) / B.cpmB; if (dCpm >= 0.18) sigs.push(`CPM较前期${pc(dCpm)}`); }
    }
    if (B.roiB > 0 && B.L.sp >= 10) { dRoi = (B.L.rn / B.L.sp - B.roiB) / B.roiB; if (dRoi <= -0.3) sigs.push(`ROI较峰值${pc(dRoi)}`); }
    const shrink = a.days.size >= 6 && B.L.sp / 3 < dayAvg * 0.4;
    if (shrink) sigs.push('跑量萎缩(近3日<日均40%)');
    const dead = dCtr != null && dCtr <= -0.4;

    let grade, why, act;
    if (a.sp < 15 || a.imp < 3000) {
      grade = '🧪测试中';
      why = `消耗$${f1(a.sp)}/曝光${Math.round(a.imp)},未达读数门槛(≥$15且≥3k曝光)`;
      act = a.imp < 1000 ? '曝光<1k,不读数,继续投' : '方向性观察,达门槛后判定';
    } else if (a.sp >= 30 && a.imp >= 5000 && ((ipmMed > 0 && ipm < ipmMed * 0.5 && ctrMed > 0 && ctr < ctrMed * 0.6) || (roiMed > 0 && roi <= roiMed * 0.5))) {
      grade = '🔴止损';
      why = ipm < ipmMed * 0.5 && ctr < ctrMed * 0.6
        ? `IPM ${f2(ipm)} <中位(${f2(ipmMed)})一半 且 CTR <中位60%,测试失败`
        : `ROI ${f2(roi)} ≤ 项目中位(${f2(roiMed)})×0.5,已花$${f1(a.sp)}`;
      act = '关停,预算让给机会/主力素材';
    } else if (a.sp >= 30 && (dead || sigs.length >= 2 || (dRoi != null && dRoi <= -0.3))) {
      grade = '⚠️疲劳衰退';
      why = `相对自身峰值7日窗口:${sigs.join(';')}`;
      act = dead ? 'Replace:CTR较峰值-40%,立即停换新概念' : 'Refresh:减预算50%,换hook出迭代版(保留主体)';
    } else if (a.sp >= 15 && a.sp < 60 && a.inst >= 10 && roi >= Math.max(roiMed, 0.25)
      && ((ipmMed > 0 && ipm >= ipmMed * 1.3) || (cpiMed > 0 && cpi != null && cpi <= cpiMed * 0.8))) {
      grade = '🚀机会素材';
      why = `双门槛达标(${a.inst}安装/$${f1(a.sp)}):IPM ${f2(ipm)}${ipmMed ? `(中位${f2(ipmMed)})` : ''} 或 CPI优于中位20%,ROI ${f2(roi)} ≥ 中位`;
      act = '加量20~30%/次(勿翻倍重置学习期),同步做变体';
    } else if (a.sp >= 60 && roi >= Math.max(roiMed * 1.05, 0.2)) {
      grade = '🌟主力素材';
      why = `规模消耗$${f1(a.sp)}下 ROI ${f2(roi)} 仍≥项目中位(${f2(roiMed)})`;
      act = sigs.length === 1 ? `Watch:出现1个衰减信号(${sigs[0]}),备好替补` : '继续放量,盯疲劳信号';
    } else {
      grade = '✅在投';
      why = `指标在项目正常区间(ROI ${f2(roi)}/中位 ${f2(roiMed)};IPM ${f2(ipm)}/中位 ${f2(ipmMed)})`;
      act = sigs.length ? `Watch:${sigs[0]},备替补` : '正常轮换';
    }

    const topGame = Object.entries(a.games).sort((x, y) => y[1] - x[1])[0]?.[0] || '';
    mainRecs.push({ sortKey: a.sp, fields: {
      '创意素材名称': a.mat, '项目组': a.grp, '主投游戏': topGame,
      '评级': grade, '评级依据': why, '建议动作': act,
      '疲劳信号': sigs.join(';') || '', '是否新素材': a.first >= maxS - 6 ? '是' : '',
      'Top素材': (topByProj[a.grp] || []).includes(a.mat) ? '是' : '',
      '消耗': f1(a.sp), '项目消耗占比': proj[a.grp]?.sp ? f4(a.sp / proj[a.grp].sp) : null,
      '广告首日ROI': f4(roi), '项目中位ROI': f4(roiMed), 'D6回本倍数': d6x != null ? f2(d6x) : null,
      '吸睛率EVR': f4(evr), '点击率': f4(ctr), '安装转化率CVR': f4(cvr),
      'IPM': f2(ipm), '项目中位IPM': f2(ipmMed), 'CPI': cpi != null ? f2(cpi) : null,
      '首启率': a.inst ? f4(Math.min(a.nu / a.inst, 9.99)) : null,
      '广告新增': Math.round(a.nu), '新增成本': a.nu ? f2(a.sp / a.nu) : null,
      'CPM': a.imp ? f1(a.sp / a.imp * 1000) : null, 'CPC': a.clk ? f2(a.sp / a.clk) : null,
      '展示量': Math.round(a.imp), '安装数': Math.round(a.inst),
      '近3日CTR较峰值': dCtr != null ? f4(dCtr) : null, '近3日IPM较峰值': dIpm != null ? f4(dIpm) : null,
      '近3日CPM较前期': dCpm != null ? f4(dCpm) : null, '近3日ROI较峰值': dRoi != null ? f4(dRoi) : null,
      '近3日消耗': f1(B.L.sp), '日均消耗': f1(dayAvg),
      '在投天数': a.days.size, '首投日期': msOf(a.first), '末投日期': msOf(a.last),
    } });
  });
  mainRecs.sort((x, y) => y.sortKey - x.sortKey);

  // ── 素材日趋势(消耗≥$10 的素材;Top/新素材标记供图表筛选)──────────────
  const dayRecs = [];
  Object.values(agg).filter(a => a.sp >= 10).forEach(a => {
    const isTop = (topByProj[a.grp] || []).includes(a.mat);
    const isNew = a.first >= maxS - 6;
    Object.entries(a.daily).forEach(([s, d]) => {
      dayRecs.push({ fields: {
        '日期': msOf(+s), '创意素材名称': a.mat, '项目组': a.grp,
        '消耗': f1(d.sp), '点击率': d.imp ? f4(d.clk / d.imp) : null,
        'CPM': d.imp ? f1(d.sp / d.imp * 1000) : null,
        '广告首日ROI': d.sp ? f4(d.rn / d.sp) : null,
        'IPM': d.imp ? f2(d.inst / d.imp * 1000) : null,
        'Top素材': isTop ? '是' : '', '是否新素材': isNew ? '是' : '',
      } });
    });
  });

  // ── 素材漏斗(分项目;①~⑤前缀保证漏斗顺序)────────────────────────────
  const funRecs = [];
  Object.entries(proj).forEach(([g, p]) => {
    if (p.sp < 10) return;
    const stages = [
      ['① 曝光', p.imp, null],
      ['② 6s互动观看', p.ev, p.imp ? p.ev / p.imp : null],
      ['③ 点击', p.clk, p.ev ? p.clk / p.ev : null],
      ['④ 安装', p.inst, p.clk ? p.inst / p.clk : null],
      ['⑤ 游戏新增', p.nu, p.inst ? p.nu / p.inst : null],
    ];
    stages.forEach(([st, v, cv]) => funRecs.push({ fields: {
      '项目组': g, '阶段': st, '数值': Math.round(v), '转化率(上级)': cv != null ? f4(cv) : null,
    } }));
  });

  // ── 写表 ────────────────────────────────────────────────────────────────
  const tables = await listTables(token);
  const mainT = await ensureTable(token, tables, T_MAIN, MAIN_FIELDS);
  await writeRecs(token, mainT, mainRecs.map(x => ({ fields: x.fields })));
  const dayT = await ensureTable(token, tables, T_DAY, DAY_FIELDS);
  await writeRecs(token, dayT, dayRecs);
  const funT = await ensureTable(token, tables, T_FUN, FUN_FIELDS);
  await writeRecs(token, funT, funRecs);

  // 行动清单视图(评级)+ 项目组视图
  const fields = (await api('GET', `/open-apis/bitable/v1/apps/${BASE}/tables/${mainT}/fields?page_size=50`, token)).data?.items || [];
  const gradeFid = fields.find(x => x.field_name === '评级')?.field_id;
  const grpFid = fields.find(x => x.field_name === '项目组')?.field_id;
  const views = (await api('GET', `/open-apis/bitable/v1/apps/${BASE}/tables/${mainT}/views?page_size=100`, token)).data?.items || [];
  const have = new Set(views.map(v => v.view_name));
  const wantViews = [
    ...['🚀机会素材', '⚠️疲劳衰退', '🔴止损'].map(g => [g, gradeFid]),
    ...[...new Set(mainRecs.map(x => x.fields['项目组']).filter(Boolean))].map(g => [g, grpFid]),
  ];
  for (const [name, fid] of wantViews) {
    if (have.has(name) || !fid) continue;
    const cv = await api('POST', `/open-apis/bitable/v1/apps/${BASE}/tables/${mainT}/views`, token, { view_name: name, view_type: 'grid' });
    if (cv.data?.view?.view_id) await api('PATCH', `/open-apis/bitable/v1/apps/${BASE}/tables/${mainT}/views/${cv.data.view.view_id}`, token,
      { property: { filter_info: { conjunction: 'and', conditions: [{ field_id: fid, operator: 'is', value: JSON.stringify([name]) }] } } });
  }

  const stat = {};
  mainRecs.forEach(x => { stat[x.fields['评级']] = (stat[x.fields['评级']] || 0) + 1; });
  console.log(`✅ 素材分析v2 ${mainRecs.length} 素材 / 日趋势 ${dayRecs.length} 行 / 漏斗 ${funRecs.length} 行: ${Object.entries(stat).map(([k, v]) => k + v).join(' / ')}`);
}
if (require.main === module) main().catch(e => { console.error('ERR', e.message); process.exit(1); });
module.exports = { main };
