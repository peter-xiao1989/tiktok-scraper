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
  if (old) return old.table_id;
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
  const r = await api('GET', `/open-apis/sheets/v2/spreadsheets/${SS}/values/jdlBTh!C2:F40?valueRenderOption=FormattedValue`, token);
  const rows = (r.data?.valueRange?.values || []).filter(x => x[0]);  // C项目组 D游戏 E出价 F消耗
  const byGrp = {}; let total = 0;
  rows.forEach(x => { const sp = pnum(x[3]); byGrp[x[0]] = (byGrp[x[0]] || 0) + sp; total += sp; });

  const logT = await ensureTable(token, T_LOG, [
    { field_name: '日期', type: 1 }, { field_name: '小时', type: 2 }, { field_name: '项目组', type: 1 },
    { field_name: '消耗', type: 2 }, { field_name: '记录时间', type: 5 },
  ], tables);
  const existing = await allRecords(token, logT);
  // 同日同小时已记过(workflow 兜底重复触发)则跳过追加
  const dup = existing.some(x => x.fields['日期'] === tag && x.fields['小时'] === hour && x.fields['项目组'] === '全部');
  if (!dup) {
    const recs = [{ fields: { '日期': tag, '小时': hour, '项目组': '全部', '消耗': Math.round(total * 10) / 10, '记录时间': Date.now() } }];
    Object.entries(byGrp).forEach(([g, sp]) => recs.push({ fields: { '日期': tag, '小时': hour, '项目组': g, '消耗': Math.round(sp * 10) / 10, '记录时间': Date.now() } }));
    await api('POST', `/open-apis/bitable/v1/apps/${BASE}/tables/${logT}/records/batch_create`, token, { records: recs });
  }
  // 清理今昨之外的旧记录(表只留两天 → 折线图天然 今天vs昨天 双线)
  const stale = existing.filter(x => x.fields['日期'] !== tag && x.fields['日期'] !== ytag).map(x => x.record_id);
  for (let i = 0; i < stale.length; i += 500) await api('POST', `/open-apis/bitable/v1/apps/${BASE}/tables/${logT}/records/batch_delete`, token, { records: stale.slice(i, i + 500) });

  // 同时段对比:昨天同小时(找不到则取昨天 ≤当前小时 最近一条)
  const yRows = existing.filter(x => x.fields['日期'] === ytag && x.fields['项目组'] === '全部');
  let yMatch = yRows.find(x => x.fields['小时'] === hour);
  if (!yMatch) yMatch = yRows.filter(x => x.fields['小时'] <= hour).sort((a, b) => b.fields['小时'] - a.fields['小时'])[0];
  const ySpend = yMatch ? pnum(yMatch.fields['消耗']) : null;
  // 长格式(今日/昨日同时段各一行)→ 一张柱图双柱同框对比;环比只在今日行(卡 AVERAGE 取到)
  const cmpT = await ensureTable(token, T_CMP, [
    { field_name: '时点', type: 1 }, { field_name: '消耗', type: 2 },
    { field_name: '同时段环比', type: 2 }, { field_name: '记录时间', type: 5 },
  ], tables);
  const old = await allRecords(token, cmpT);
  if (old.length) await api('POST', `/open-apis/bitable/v1/apps/${BASE}/tables/${cmpT}/records/batch_delete`, token, { records: old.map(x => x.record_id) });
  const cmpRecs = [{ fields: { '时点': '① 今日实时', '消耗': Math.round(total * 10) / 10,
    '同时段环比': ySpend ? Math.round((total - ySpend) / ySpend * 100) / 100 : null, '记录时间': Date.now() } }];
  if (ySpend != null) cmpRecs.push({ fields: { '时点': '② 昨日同时段', '消耗': Math.round(ySpend * 10) / 10, '记录时间': Date.now() } });
  await api('POST', `/open-apis/bitable/v1/apps/${BASE}/tables/${cmpT}/records/batch_create`, token, { records: cmpRecs });
  console.log(`✅ 时录 ${tag} ${hour}点 总消耗${Math.round(total * 10) / 10}${ySpend != null ? ` vs 昨日同时段${ySpend}` : '(昨日无记录,明日起有对比)'}`);
}
if (require.main === module) main().catch(e => { console.error('ERR', e.message); process.exit(1); });
module.exports = { main };
