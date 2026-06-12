#!/usr/bin/env node
// 枪战数据同步:把【经营日报】项目维度中 项目组=枪战 的数据(近30天,去掉手动/
// 自动出价列)同步到独立 base「枪战数据同步」,供单项目仪表盘。挂 sync-base chanpin。
const https = require('https');
const { getFeishuToken } = require('./build-summaries');

const SS = 'J8mswO2vziyIAAkdt4rcVeaDnog';
// 单项目数据同步配置:每项目独立 base(或共用 base 分表),表名前缀=项目名
const PROJECTS = [
  { group: '枪战', base: 'X89dbn5DZaYhMqsjcE1cZv3snD4' },
  { group: '齿轮', base: 'WE2TbdhjOaD7ssszrXbcmiK6nLg' },
  { group: '战车', base: 'WE2TbdhjOaD7ssszrXbcmiK6nLg' },
];
const SKIP_COLS = new Set(['序号', '手动出价消耗', '手动出价ROI', '自动出价消耗', '自动出价ROI']);
const RENAME = { '广告总收入': '收入', '广告收入 ROAS (TikTok)': '广告首日ROI' };

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

async function syncProject(token, GROUP, QZ) {
  const TABLE = `${GROUP}-经营日报(每日)`;
  // 读 JIKPZV 全表(FormattedValue)
  let grid = [], s = 1;
  while (s < 2000) {
    const r = await api('GET', `/open-apis/sheets/v2/spreadsheets/${SS}/values/JIKPZV!A${s}:AZ${s + 499}?valueRenderOption=FormattedValue`, token);
    const vs = r.data?.valueRange?.values || []; if (!vs.length) break;
    grid = grid.concat(vs); if (vs.length < 500) break; s += 500;
  }
  const rawHeader = grid[0].map(v => String(v || '').trim());
  const keep = rawHeader.map((h, j) => ({ h: RENAME[h] || h, j })).filter(x => x.h && !SKIP_COLS.has(rawHeader[x.j]));
  const gi = rawHeader.indexOf('项目组'), di = rawHeader.indexOf('统计周期');
  const rows = grid.slice(1).filter(r => String(r[gi] || '').trim() === GROUP && serAny(r[di]));
  const maxSer = Math.max(...rows.map(r => serAny(r[di])));
  const since = maxSer - 29;
  const win = rows.filter(r => serAny(r[di]) >= since).sort((a, b) => serAny(b[di]) - serAny(a[di]));

  // 列类型
  const isPct = h => /ROAS|ROI|率|次留|留存/.test(h);
  const kind = keep.map(({ h, j }) => {
    if (h === '统计周期') return 'date';
    if (h === '项目组') return 'text';
    if (isPct(h)) return 'pct';
    return 'num';
  });
  const fields = keep.map(({ h }, k) => ({ field_name: h, type: kind[k] === 'date' ? 5 : kind[k] === 'text' ? 1 : 2 }));
  fields.push({ field_name: '是否昨日', type: 1 });
  fields.push({ field_name: '月份', type: 1 });

  // ensure 表(复用清写+补字段)
  const tables = (await api('GET', `/open-apis/bitable/v1/apps/${QZ}/tables?page_size=100`, token)).data?.items || [];
  let tid = tables.find(x => x.name === TABLE)?.table_id;
  if (tid) {
    let all = [], pt = '';
    do { const r = await api('GET', `/open-apis/bitable/v1/apps/${QZ}/tables/${tid}/records?page_size=500${pt ? '&page_token=' + pt : ''}`, token); (r.data?.items || []).forEach(x => all.push(x.record_id)); pt = r.data?.has_more ? r.data.page_token : ''; } while (pt);
    for (let i = 0; i < all.length; i += 500) await api('POST', `/open-apis/bitable/v1/apps/${QZ}/tables/${tid}/records/batch_delete`, token, { records: all.slice(i, i + 500) });
    const exist = new Set(((await api('GET', `/open-apis/bitable/v1/apps/${QZ}/tables/${tid}/fields?page_size=100`, token)).data?.items || []).map(x => x.field_name));
    for (const f of fields) if (!exist.has(f.field_name)) await api('POST', `/open-apis/bitable/v1/apps/${QZ}/tables/${tid}/fields`, token, { field_name: f.field_name, type: f.type });
  } else tid = (await api('POST', `/open-apis/bitable/v1/apps/${QZ}/tables`, token, { table: { name: TABLE, fields } })).data?.table_id;

  const recs = win.map((r, i) => {
    const f = {};
    keep.forEach(({ h, j }, k) => {
      const v = String(r[j] ?? '').trim(); if (v === '') return;
      if (kind[k] === 'date') f[h] = (serAny(v) - 25569) * 864e5;
      else if (kind[k] === 'pct') f[h] = ppct(v);
      else if (kind[k] === 'num') f[h] = pnum(v);
      else f[h] = v;
    });
    f['是否昨日'] = i === 0 ? '是' : '';
    { const ms = f['统计周期']; if (ms) { const dt = new Date(ms + 288e5); f['月份'] = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`; } }
    return { fields: f };
  });
  for (let i = 0; i < recs.length; i += 200) {
    const w = await api('POST', `/open-apis/bitable/v1/apps/${QZ}/tables/${tid}/records/batch_create`, token, { records: recs.slice(i, i + 200) });
    if (w.code !== 0) throw new Error('write: ' + JSON.stringify(w).slice(0, 120));
  }
  console.log(`✅ ${GROUP}-经营日报 ${recs.length} 行 (${fields.length}字段, ${tid})`);

  // ── 枪战-包体日报(每日):6B1PVx 枪战行,近30天 ──
  let g2 = [], s2 = 1;
  while (s2 < 2000) {
    const r = await api('GET', `/open-apis/sheets/v2/spreadsheets/${SS}/values/6B1PVx!A${s2}:V${s2 + 499}?valueRenderOption=FormattedValue`, token);
    const vs = r.data?.valueRange?.values || []; if (!vs.length) break;
    g2 = g2.concat(vs); if (vs.length < 500) break; s2 += 500;
  }
  // A序号0 B统计周期1 C项目组2 D游戏3 E消耗4 F_ROAS5 G广告新增6 H新增成本7 K收入10 L新增用户11
  const pkRows = g2.slice(1).filter(r => String(r[2] || '').trim() === GROUP && serAny(r[1]) && serAny(r[1]) >= since)
    .sort((a, b) => serAny(b[1]) - serAny(a[1]));
  const pkFields = [
    { field_name: '游戏名称', type: 1 }, { field_name: '统计周期', type: 5 }, { field_name: '消耗', type: 2 },
    { field_name: '收入', type: 2 }, { field_name: '广告首日ROI', type: 2 }, { field_name: '广告新增', type: 2 },
    { field_name: '广告新增成本', type: 2 }, { field_name: '新增用户', type: 2 },
    { field_name: '是否昨日', type: 1 }, { field_name: '月份', type: 1 },
  ];
  const tables2 = (await api('GET', `/open-apis/bitable/v1/apps/${QZ}/tables?page_size=100`, token)).data?.items || [];
  let tid2 = tables2.find(x => x.name === `${GROUP}-包体日报(每日)`)?.table_id;
  if (tid2) {
    let all = [], pt = '';
    do { const r = await api('GET', `/open-apis/bitable/v1/apps/${QZ}/tables/${tid2}/records?page_size=500${pt ? '&page_token=' + pt : ''}`, token); (r.data?.items || []).forEach(x => all.push(x.record_id)); pt = r.data?.has_more ? r.data.page_token : ''; } while (pt);
    for (let i = 0; i < all.length; i += 500) await api('POST', `/open-apis/bitable/v1/apps/${QZ}/tables/${tid2}/records/batch_delete`, token, { records: all.slice(i, i + 500) });
    const exist = new Set(((await api('GET', `/open-apis/bitable/v1/apps/${QZ}/tables/${tid2}/fields?page_size=100`, token)).data?.items || []).map(x => x.field_name));
    for (const f of pkFields) if (!exist.has(f.field_name)) await api('POST', `/open-apis/bitable/v1/apps/${QZ}/tables/${tid2}/fields`, token, { field_name: f.field_name, type: f.type });
  } else tid2 = (await api('POST', `/open-apis/bitable/v1/apps/${QZ}/tables`, token, { table: { name: `${GROUP}-包体日报(每日)`, fields: pkFields } })).data?.table_id;
  const ySer = maxSer;
  const pkRecs2 = pkRows.map(r => {
    const ser = serAny(r[1]); const ms = (ser - 25569) * 864e5;
    const dt = new Date(ms + 288e5);
    return { fields: {
      '游戏名称': String(r[3] || ''), '统计周期': ms, '消耗': pnum(r[4]), '收入': pnum(r[10]),
      '广告首日ROI': ppct(r[5]), '广告新增': pnum(r[6]), '广告新增成本': pnum(r[7]), '新增用户': pnum(r[11]),
      '是否昨日': ser === ySer ? '是' : '', '月份': `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`,
    } };
  });
  for (let i = 0; i < pkRecs2.length; i += 200) await api('POST', `/open-apis/bitable/v1/apps/${QZ}/tables/${tid2}/records/batch_create`, token, { records: pkRecs2.slice(i, i + 200) });
  console.log(`✅ ${GROUP}-包体日报 ${pkRecs2.length} 行 (${tid2})`);
  return tid;
}
async function main() {
  const token = await getFeishuToken();
  for (const { group, base } of PROJECTS) await syncProject(token, group, base);
}
if (require.main === module) main().catch(e => { console.error('ERR', e.message); process.exit(1); });
module.exports = { main };
