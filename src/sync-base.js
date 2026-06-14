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
  ['JIKPZV', '【经营日报】-项目维度', 'chanpin'],
  ['6B1PVx', '【经营日报】-包体维度', 'chanpin'],
  ['kX0M0R', '【投放日报】-产品维度', 'toufang'],
  ['TOBfe9', '【投放日报】-素材维度', 'toufang'],
  ['2zDzau', '【投放日报】-出价维度', 'toufang'],
  ['dbGqhL', '【每小时】素材数据监测', 'fenshi'],
  ['jdlBTh', '【每小时】投放数据监测', 'fenshi'],
];
// 该字段为空的行跳过(去掉电子表格里的"汇总-N"行,汇总由仪表盘聚合体现)
const REQUIRE_COL = { '【每小时】投放数据监测': '项目组', '【每小时】素材数据监测': '创意素材名称' };
const SKIP = new Set(['序号', '类别']);
// 多维表字段显示名重命名(值和来源不变,只改多维表里的列名)。key=多维表名。
const RENAME = {
  '日经营数据汇总': { '广告总收入': '收入', '广告收入 ROAS (TikTok)': '广告首日ROI' },
  '【经营日报】-项目维度': { '广告总收入': '收入', '广告收入 ROAS (TikTok)': '广告首日ROI' },
  '【经营日报】-包体维度': { '广告收入 ROAS (TikTok)': '广告首日ROI', '活跃度': '广告新增', '活跃度平均成本': '广告新增成本' },
  '【投放日报】-出价维度': { '广告收入 ROAS (TikTok)': '广告首日ROI' },
};
const DATE_COLS = new Set(['统计周期', '按天', '更新时间', '日期']);
// 总表后自动维护的筛选视图:{多维表名: 筛选字段}。数据里该字段的每个值一个视图,
// 新项目组/新游戏出现时下次同步自动补建(只补缺不删,用户自建视图不受影响)。
const FILTER_VIEWS = {
  // sortBy: 视图顺序按近 N 天 valueField 合计降序(消耗最高排最前);无 sortBy 按名称序
  '【经营日报】-项目维度': { field: '项目组', sortBy: { dateField: '统计周期', valueField: '消耗', days: 7 } },
  '【经营日报】-包体维度': { field: '游戏名称', sortBy: { dateField: '统计周期', valueField: '消耗', days: 1 } },
  '【投放日报】-素材维度': { field: '项目组' },
  '【投放日报】-出价维度': { field: '项目组' },
};
const isPctCol = h => /ROAS|ROI|率|次留|留存/.test(h);

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
// 日期→毫秒:含时分(北京时间)精确到分钟转 UTC;纯日期取 UTC 0点(显示当天)
const serMs = v => {
  const m = /(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/.exec(String(v == null ? '' : v));
  if (!m) return null;
  if (m[4] != null) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5]);
  return Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 864e5) * 864e5;
};

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
// 确保 values 中每个值都有同名筛选视图(字段=值)。enforceOrder 时若现有顺序与
// values 不一致,删掉这些筛选视图按序重建(视图顺序=创建顺序,API 无移动接口)。
async function ensureFilterViews(token, tid, fieldName, values, enforceOrder) {
  const fields = (await api('GET', `/open-apis/bitable/v1/apps/${BASE}/tables/${tid}/fields?page_size=100`, token)).data?.items || [];
  const fid = fields.find(x => x.field_name === fieldName)?.field_id;
  if (!fid) return;
  let views = (await api('GET', `/open-apis/bitable/v1/apps/${BASE}/tables/${tid}/views?page_size=100`, token)).data?.items || [];
  if (enforceOrder) {
    const cur = views.filter(v => values.includes(v.view_name)).map(v => v.view_name);
    const want = values.filter(v => cur.includes(v));
    if (JSON.stringify(cur) !== JSON.stringify(want)) {
      for (const v of views) {
        if (!values.includes(v.view_name)) continue;
        await api('DELETE', `/open-apis/bitable/v1/apps/${BASE}/tables/${tid}/views/${v.view_id}`, token);
      }
      views = views.filter(v => !values.includes(v.view_name));
      console.log(`  ↻ 筛选视图按消耗重排`);
    }
  }
  const have = new Set(views.map(v => v.view_name));
  for (const val of values) {
    if (!val || have.has(val)) continue;
    const cv = await api('POST', `/open-apis/bitable/v1/apps/${BASE}/tables/${tid}/views`, token, { view_name: val, view_type: 'grid' });
    const vid = cv.data?.view?.view_id;
    if (!vid) { console.log(`  视图「${val}」建失败 ${cv.code}`); continue; }
    await api('PATCH', `/open-apis/bitable/v1/apps/${BASE}/tables/${tid}/views/${vid}`, token,
      { property: { filter_info: { conjunction: 'and', conditions: [{ field_id: fid, operator: 'is', value: JSON.stringify([val]) }] } } });
    console.log(`  ➕ 筛选视图「${val}」`);
  }
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
      && !/^\d+(\.\d+)?$/.test(x.h) && !/^test\d*$/i.test(x.h));   // 排除纯数字/test 等污染表头
  const rmap = RENAME[name] || {};
  const header = keep.map(x => rmap[x.h] || x.h);   // 字段显示名重命名(值不变)
  let data = grid.slice(1).map(row => keep.map(x => String(row[x.j] ?? '').trim())).filter(r => r.some(v => v));
  const reqCol = REQUIRE_COL[name];
  if (reqCol) { const ri = header.indexOf(reqCol); if (ri >= 0) data = data.filter(r => r[ri]); }
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
  if (old) {
    tid = old.table_id; await clearRecords(token, tid);
    // 自动补缺字段(电子表格新增列时多维表跟着加,否则写入报未知字段)
    const exist = new Set(((await api('GET', `/open-apis/bitable/v1/apps/${BASE}/tables/${tid}/fields?page_size=100`, token)).data?.items || []).map(x => x.field_name));
    for (const f of fields) {
      if (exist.has(f.field_name)) continue;
      const r = await api('POST', `/open-apis/bitable/v1/apps/${BASE}/tables/${tid}/fields`, token, { field_name: f.field_name, type: f.type });
      console.log(`  ${name}: 补字段「${f.field_name}」${r.code === 0 ? '✅' : '❌' + r.code}`);
    }
  }
  else {
    const cr = await api('POST', `/open-apis/bitable/v1/apps/${BASE}/tables`, token, { table: { name, fields } });
    tid = cr.data?.table_id;
  }
  if (!tid) { console.log(`  ${name}: 建/取表失败 ${JSON.stringify(old || '').slice(0, 80)}`); return; }

  const recs = data.map(r => {
    const f = {};
    header.forEach((h, k) => {
      const v = r[k]; if (v === '') return;
      if (kind[k] === 'date') { const ms = serMs(v); if (ms != null) f[h] = ms; }
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
  // 自动维护按字段值的筛选视图(新组/新游戏出现自动补建;sortBy 按近N天消耗排序)
  const vf = FILTER_VIEWS[name];
  if (vf) {
    const vi = header.indexOf(vf.field);
    if (vi >= 0) {
      let vals = [...new Set(data.map(r => r[vi]).filter(v => v))];
      if (vf.sortBy) {
        const { dateField, valueField, days } = vf.sortBy;
        const di = header.indexOf(dateField), xi = header.indexOf(valueField);
        const serOf = v => { const m = /(\d{4})[/-](\d{1,2})[/-](\d{1,2})/.exec(String(v)); return m ? Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 864e5) : null; };
        const maxSer = Math.max(...data.map(r => serOf(r[di]) || 0));
        const since = maxSer - (days - 1);
        const sum = {};
        data.forEach(r => { const s = serOf(r[di]); if (s != null && s >= since) sum[r[vi]] = (sum[r[vi]] || 0) + pnum(r[xi]); });
        vals.sort((a, b) => (sum[b] || 0) - (sum[a] || 0));
      } else vals.sort();
      await ensureFilterViews(token, tid, vf.field, vals, !!vf.sortBy);
    }
  }
}

async function main() {
  const only = process.argv[2] || 'all';
  const token = await getFeishuToken();
  const tables = await listTables(token);
  for (const [sheet, name, grp] of SHEETS) {
    if (only !== 'all' && only !== grp && only !== name) continue;
    await syncTable(token, sheet, name, tables);
  }
  // 每日经营概览 + 数据周报/月报 + 游戏质量分析 + 昨日速览 一并刷新
  if (only === 'all' || only === 'chanpin') {
    await require('./build-overview').main();
    await require('./build-investor-report').main();
    await require('./build-quality-report').main();
    await require('./build-yesterday').main();
    await require('./build-material').main();
    await require('./sync-qiangzhan').main();
    await require('./sync-tanchi-pisa').main();
  }
  console.log('同步完成。');
}

if (require.main === module) main().catch(e => { console.error('ERR', e.message); process.exit(1); });
module.exports = { syncTable, main };
