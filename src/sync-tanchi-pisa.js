#!/usr/bin/env node
// 贪吃蛇/披萨店数据同步:把经营日报/包体日报中对应项目组的数据同步到独立 base。
// 首次运行(未设 TANCHI_PISA_BASE):自动创建 base 并打印 token,将其加为 GitHub Secret 后重跑。
const https = require('https');
const { getFeishuToken } = require('./build-summaries');

const SS = 'J8mswO2vziyIAAkdt4rcVeaDnog';
const PROJECTS = [
  { group: '贪吃蛇' },
  { group: '披萨' },
];
const SKIP_COLS = new Set(['序号', '手动出价消耗', '手动出价ROI', '自动出价消耗', '自动出价ROI']);
const RENAME = { '广告总收入': '收入', '广告收入 ROAS (TikTok)': '广告首日ROI' };
const PK_RENAME = { '广告收入 ROAS (TikTok)': '广告首日ROI', '活跃度': '广告新增', '活跃度平均成本': '广告新增成本', '广告总收入': '收入' };
const PK_SKIP = new Set(['序号', '项目组', '手动出价消耗', '手动出价ROI', '自动出价消耗', '自动出价ROI']);

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

  if (!rows.length) { console.log(`ℹ️  ${GROUP}-经营日报: 暂无数据(JIKPZV 中无该项目组行)`); }

  const maxSer = rows.length ? Math.max(...rows.map(r => serAny(r[di]))) : 0;
  const since = maxSer - 29;
  const win = rows.filter(r => serAny(r[di]) >= since).sort((a, b) => serAny(b[di]) - serAny(a[di]));

  const isPct = h => /ROAS|ROI|率|次留|留存/.test(h);
  const kind = keep.map(({ h }) => h === '统计周期' ? 'date' : h === '项目组' ? 'text' : isPct(h) ? 'pct' : 'num');
  const fields = keep.map(({ h }, k) => ({ field_name: h, type: kind[k] === 'date' ? 5 : kind[k] === 'text' ? 1 : 2 }));
  fields.push({ field_name: '是否昨日', type: 1 });
  fields.push({ field_name: '月份', type: 1 });

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
  console.log(`✅ ${GROUP}-经营日报 ${recs.length} 行 (${tid})`);

  // ── 包体日报 ──────────────────────────────────────────────────────────
  let g2 = [], s2 = 1;
  while (s2 < 2000) {
    const r = await api('GET', `/open-apis/sheets/v2/spreadsheets/${SS}/values/6B1PVx!A${s2}:V${s2 + 499}?valueRenderOption=FormattedValue`, token);
    const vs = r.data?.valueRange?.values || []; if (!vs.length) break;
    g2 = g2.concat(vs); if (vs.length < 500) break; s2 += 500;
  }
  const pkRawHeader = g2[0].map(v => String(v || '').trim());
  const pkKeep = pkRawHeader.map((h, j) => ({ h: PK_RENAME[h] || h, j }))
    .filter(x => x.h && !x.h.startsWith('_') && !PK_SKIP.has(pkRawHeader[x.j]));
  const pkRows = g2.slice(1).filter(r => String(r[2] || '').trim() === GROUP && serAny(r[1]) && serAny(r[1]) >= since)
    .sort((a, b) => serAny(b[1]) - serAny(a[1]));

  if (!pkRows.length) { console.log(`ℹ️  ${GROUP}-包体日报: 暂无数据(6B1PVx 中无该项目组行)`); }

  const pkIsPct = h => /ROAS|ROI|率|次留|留存/.test(h);
  const pkKind = pkKeep.map(({ h }) => h === '统计周期' ? 'date' : h === '游戏名称' ? 'text' : pkIsPct(h) ? 'pct' : 'num');
  const pkFields = pkKeep.map(({ h }, k) => ({ field_name: h, type: pkKind[k] === 'date' ? 5 : pkKind[k] === 'text' ? 1 : 2 }));
  pkFields.push({ field_name: '是否昨日', type: 1 });
  pkFields.push({ field_name: '月份', type: 1 });

  const tables2 = (await api('GET', `/open-apis/bitable/v1/apps/${QZ}/tables?page_size=100`, token)).data?.items || [];
  let tid2 = tables2.find(x => x.name === `${GROUP}-包体日报(每日)`)?.table_id;
  if (tid2) {
    let all = [], pt = '';
    do { const r = await api('GET', `/open-apis/bitable/v1/apps/${QZ}/tables/${tid2}/records?page_size=500${pt ? '&page_token=' + pt : ''}`, token); (r.data?.items || []).forEach(x => all.push(x.record_id)); pt = r.data?.has_more ? r.data.page_token : ''; } while (pt);
    for (let i = 0; i < all.length; i += 500) await api('POST', `/open-apis/bitable/v1/apps/${QZ}/tables/${tid2}/records/batch_delete`, token, { records: all.slice(i, i + 500) });
    const exist = new Set(((await api('GET', `/open-apis/bitable/v1/apps/${QZ}/tables/${tid2}/fields?page_size=100`, token)).data?.items || []).map(x => x.field_name));
    for (const f of pkFields) if (!exist.has(f.field_name)) await api('POST', `/open-apis/bitable/v1/apps/${QZ}/tables/${tid2}/fields`, token, { field_name: f.field_name, type: f.type });
  } else tid2 = (await api('POST', `/open-apis/bitable/v1/apps/${QZ}/tables`, token, { table: { name: `${GROUP}-包体日报(每日)`, fields: pkFields } })).data?.table_id;

  const pkRecs = pkRows.map(r => {
    const ser = serAny(r[1]); const ms = (ser - 25569) * 864e5;
    const dt = new Date(ms + 288e5);
    const f = {};
    pkKeep.forEach(({ h, j }, k) => {
      const v = String(r[j] ?? '').trim(); if (v === '') return;
      if (pkKind[k] === 'date') f[h] = ms;
      else if (pkKind[k] === 'pct') f[h] = ppct(v);
      else if (pkKind[k] === 'num') f[h] = pnum(v);
      else f[h] = v;
    });
    f['是否昨日'] = ser === maxSer ? '是' : '';
    f['月份'] = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
    return { fields: f };
  });
  for (let i = 0; i < pkRecs.length; i += 200) await api('POST', `/open-apis/bitable/v1/apps/${QZ}/tables/${tid2}/records/batch_create`, token, { records: pkRecs.slice(i, i + 200) });
  console.log(`✅ ${GROUP}-包体日报 ${pkRecs.length} 行 (${tid2})`);

  // ── 包体表按游戏名称维护筛选视图 ─────────────────────────────────────
  {
    const ySpend = {};
    pkRecs.forEach(r => { if (r.fields['是否昨日'] === '是') ySpend[r.fields['游戏名称']] = pnum(r.fields['消耗']); });
    const games = [...new Set(pkRecs.map(r => r.fields['游戏名称']).filter(Boolean))]
      .sort((a, b) => (ySpend[b] || 0) - (ySpend[a] || 0));
    const flds = (await api('GET', `/open-apis/bitable/v1/apps/${QZ}/tables/${tid2}/fields?page_size=50`, token)).data?.items || [];
    const fid = flds.find(x => x.field_name === '游戏名称')?.field_id;
    if (fid && games.length) {
      let views = (await api('GET', `/open-apis/bitable/v1/apps/${QZ}/tables/${tid2}/views?page_size=100`, token)).data?.items || [];
      const cur = views.filter(v => games.includes(v.view_name)).map(v => v.view_name);
      const want = games.filter(g => cur.includes(g));
      if (JSON.stringify(cur) !== JSON.stringify(want)) {
        for (const v of views) { if (!games.includes(v.view_name)) continue;
          await api('DELETE', `/open-apis/bitable/v1/apps/${QZ}/tables/${tid2}/views/${v.view_id}`, token); }
        views = views.filter(v => !games.includes(v.view_name));
      }
      const have = new Set(views.map(v => v.view_name));
      for (const g of games) {
        if (have.has(g)) continue;
        const cv = await api('POST', `/open-apis/bitable/v1/apps/${QZ}/tables/${tid2}/views`, token, { view_name: g, view_type: 'grid' });
        if (cv.data?.view?.view_id) await api('PATCH', `/open-apis/bitable/v1/apps/${QZ}/tables/${tid2}/views/${cv.data.view.view_id}`, token,
          { property: { filter_info: { conjunction: 'and', conditions: [{ field_id: fid, operator: 'is', value: JSON.stringify([g]) }] } } });
        console.log(`  ➕ 视图「${g}」`);
      }
    }
  }
}

async function main() {
  const token = await getFeishuToken();
  let QZ = process.env.TANCHI_PISA_BASE;
  if (!QZ) {
    // 首次运行:自动创建 base,打印 token 后退出
    const r = await api('POST', '/open-apis/bitable/v1/apps', token, { app: { name: '贪吃蛇/披萨店经营数据中心' } });
    QZ = r.data?.app?.app_token;
    if (!QZ) throw new Error('创建 base 失败: ' + JSON.stringify(r).slice(0, 200));
    console.log(`\n✅ 新建 base 成功！\napp_token: ${QZ}\n`);
    console.log('请将上方 app_token 加为 GitHub Secret: TANCHI_PISA_BASE');
    console.log('然后重新触发 workflow 完成数据同步。\n');
    return;
  }
  for (const { group } of PROJECTS) await syncProject(token, group, QZ);
}
if (require.main === module) main().catch(e => { console.error('ERR', e.message); process.exit(1); });
module.exports = { main };
