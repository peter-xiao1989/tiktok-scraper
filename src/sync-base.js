#!/usr/bin/env node
// 同步电子表格静态衍生表 → 多维表 YB8TbS(TT经营数据中心),供团队建仪表盘分析。
// - 去掉"序号/类别"列(多维表用记录本身,不需要序号)
// - 数值/百分比/日期列正确分类(图表才能按数轴/日期轴聚合)
// - 删同名表重建(去序号后主字段=业务列;表无业务仪表盘视图,重建安全)
// 用法: node sync-base.js [all|chanpin|toufang|fenshi|<表名>]
const https = require('https');
const { getFeishuToken } = require('./build-summaries');

const SS = 'J8mswO2vziyIAAkdt4rcVeaDnog';
const BASE = process.env.OVERVIEW_BASE || 'YB8TbS45kaO1gesMtqlc8kpznEb';

// (sheet_id, 多维表名, 组)
const SHEETS = [
  ['wAsSso', '日经营数据汇总', 'chanpin'],
  ['JIKPZV', '项目维度经营表', 'chanpin'],
  ['6B1PVx', '各产品经营日报表', 'chanpin'],
  ['kX0M0R', '投放日报-产品维度', 'toufang'],
  ['TOBfe9', '投放日报-素材维度', 'toufang'],
  ['dbGqhL', '分时素材效果表', 'fenshi'],
];
const SKIP = new Set(['序号', '类别']);
const DATE_COLS = new Set(['统计周期', '按天', '更新时间', '日期']);
const isPctCol = h => /ROAS|ROI|率/.test(h);

function once(method, path, token, body) {
  return new Promise((res, rej) => {
    const d = body ? JSON.stringify(body) : null;
    const h = { 'Content-Type': 'application/json' };
    if (token) h.Authorization = 'Bearer ' + token;
    if (d) h['Content-Length'] = Buffer.byteLength(d);
    const r = https.request({ hostname: 'open.feishu.cn', path, method, headers: h, timeout: 25000 }, rs => {
      const c = []; rs.on('data', x => c.push(x));
      rs.on('end', () => { const raw = Buffer.concat(c).toString('utf8'); try { res(JSON.parse(raw)); } catch (e) { res({ _nonjson: raw.slice(0, 100) }); } });
    });
    r.on('timeout', () => { r.destroy(); rej(new Error('TIMEOUT')); });
    r.on('error', rej); if (d) r.write(d); r.end();
  });
}
async function api(method, path, token, body) {
  const wait = a => new Promise(s => setTimeout(s, Math.min(8000, 400 * 2 ** a) + Math.random() * 300));
  for (let a = 0; ; a++) {
    let r; try { r = await once(method, path, token, body); } catch (e) { if (a >= 7) throw e; await wait(a); continue; }
    if (r && [1254290, 1254291, 90217, 90235].includes(r.code) && a < 7) { await wait(a); continue; }
    return r;
  }
}
const pnum = v => parseFloat(String(v == null ? '' : v).replace(/[,%]/g, '')) || 0;
const ppct = v => { const s = String(v == null ? '' : v); return s.includes('%') ? pnum(s) / 100 : pnum(s); };
const ser = s => { const m = /(\d{4})[/-](\d{2})[/-](\d{2})/.exec(String(s)); return m ? Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 864e5) : null; };

async function readGrid(token, sheet) {
  let rows = [], s = 1;
  while (s < 6000) {
    const r = await api('GET', `/open-apis/sheets/v2/spreadsheets/${SS}/values/${sheet}!A${s}:BZ${s + 499}?valueRenderOption=FormattedValue`, token);
    const vs = r.data?.valueRange?.values || []; if (!vs.length) break;
    rows = rows.concat(vs); if (vs.length < 500) break; s += 500;
  }
  return rows;
}
async function listTables(token) {
  const r = await api('GET', `/open-apis/bitable/v1/apps/${BASE}/tables?page_size=100`, token);
  return r.data?.items || [];
}
async function clearRecords(token, tid) {
  let all = [], pt = '';
  do {
    const r = await api('GET', `/open-apis/bitable/v1/apps/${BASE}/tables/${tid}/records?page_size=500${pt ? '&page_token=' + pt : ''}`, token);
    (r.data?.items || []).forEach(x => all.push(x.record_id)); pt = r.data?.has_more ? r.data.page_token : '';
  } while (pt);
  for (let i = 0; i < all.length; i += 500) {
    await api('POST', `/open-apis/bitable/v1/apps/${BASE}/tables/${tid}/records/batch_delete`, token, { records: all.slice(i, i + 500) });
  }
  return all.length;
}

async function syncTable(token, sheet, name, tables) {
  const grid = await readGrid(token, sheet);
  if (grid.length < 2) { console.log(`  ${name}: 无数据,跳过`); return; }
  const rawHeader = grid[0];
  const keep = rawHeader.map((h, j) => ({ h: String(h || '').trim(), j }))
    .filter(x => x.h && !x.h.startsWith('_') && !SKIP.has(x.h) && !/^序号\d+$/.test(x.h)
      && !/^\d+(\.\d+)?$/.test(x.h));   // 排除纯数字列名(日期serial 等污染表头)
  const header = keep.map(x => x.h);
  const data = grid.slice(1).map(row => keep.map(x => String(row[x.j] ?? '').trim())).filter(r => r.some(v => v));
  if (!data.length) { console.log(`  ${name}: 无数据行,跳过`); return; }

  // 列类型: 日期 / 百分比 / 数值 / 文本
  const kind = header.map((h, k) => {
    if (DATE_COLS.has(h)) return 'date';
    if (isPctCol(h)) return 'pct';
    const vals = data.map(r => r[k]).filter(v => v);
    if (vals.length && vals.filter(v => /^-?[\d.,%]+$/.test(v)).length / vals.length >= 0.8) return 'num';
    return 'text';
  });
  const fields = header.map((h, k) => ({ field_name: h, type: kind[k] === 'date' ? 5 : (kind[k] === 'num' || kind[k] === 'pct') ? 2 : 1 }));

  // 复用同名表(清记录),保持 table_id 稳定 → 仪表盘图表不失效。没有才建。
  // 注:当前表已是去序号结构(主字段=业务列);若电子表格 header 结构变,需手动删表让其重建。
  const old = tables.find(x => x.name === name);
  let tid;
  if (old) { tid = old.table_id; await clearRecords(token, tid); }
  else {
    const cr = await api('POST', `/open-apis/bitable/v1/apps/${BASE}/tables`, token, { table: { name, fields } });
    tid = cr.data?.table_id;
  }
  if (!tid) { console.log(`  ${name}: 建/取表失败 ${JSON.stringify(old || '').slice(0, 80)}`); return; }

  const recs = data.map(r => {
    const f = {};
    header.forEach((h, k) => {
      const v = r[k]; if (v === '') return;
      if (kind[k] === 'date') { const sd = ser(v); if (sd) f[h] = sd * 864e5; }
      else if (kind[k] === 'pct') f[h] = ppct(v);
      else if (kind[k] === 'num') f[h] = pnum(v);
      else f[h] = v;
    });
    return { fields: f };
  });
  let n = 0;
  for (let i = 0; i < recs.length; i += 200) {
    const w = await api('POST', `/open-apis/bitable/v1/apps/${BASE}/tables/${tid}/records/batch_create`, token, { records: recs.slice(i, i + 200) });
    if (w.code === 0) n += Math.min(200, recs.length - i); else { console.log(`  ${name}: 写入失败 ${JSON.stringify(w).slice(0, 80)}`); break; }
  }
  console.log(`  ✅ ${name}: ${header.length}列(去序号) × ${n}行`);
}

async function main() {
  const only = process.argv[2] || 'all';
  const token = await getFeishuToken();
  const tables = await listTables(token);
  for (const [sheet, name, grp] of SHEETS) {
    if (only !== 'all' && only !== grp && only !== name) continue;
    await syncTable(token, sheet, name, tables);
  }
  // 经营概览(每日) + 投资人周报/月报 + 游戏质量分析 一并刷新
  if (only === 'all' || only === 'chanpin') {
    await require('./build-overview').main();
    await require('./build-investor-report').main();
    await require('./build-quality-report').main();
  }
  console.log('同步完成。');
}

if (require.main === module) main().catch(e => { console.error('ERR', e.message); process.exit(1); });
module.exports = { syncTable, main };
