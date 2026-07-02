#!/usr/bin/env node
// 经营概览(每日) → 多维表 YB8TbS。从电子表格静态衍生表(日经营 wAsSso + 项目维度
// JIKPZV)算每日总览 + 环比 + 风险提示 + 一句话经营概要,写多维表供团队分析。
// 业务口径(海外游戏发行):
//   - 当日ROI = 当日收入/当日消耗(首日回收,天生偏低,仅参考)
//   - 累计ROI = 累计收入/累计消耗(回本进度,关键盈利指标;<1 未回本)
//   - 最新一天产品收入未结算(T+1,16点后到) → 标"待结算",不误报亏损
//   - 风险只报真实异常:组级累计ROI明显拖累整体、消耗骤增骤降、待结算
const https = require('https');
const { getFeishuToken } = require('./build-summaries');

const SS = 'J8mswO2vziyIAAkdt4rcVeaDnog';
const BASE = process.env.OVERVIEW_BASE || 'YB8TbS45kaO1gesMtqlc8kpznEb';
const TABLE_NAME = '【每日经营概览】';

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
const f1 = v => Math.round(v * 10) / 10;
const f2 = v => Math.round(v * 100) / 100;
const pc = v => (v >= 0 ? '+' : '') + Math.round(v * 100) + '%';

async function readSheet(token, range) {
  const r = await api('GET', `/open-apis/sheets/v2/spreadsheets/${SS}/values/${range}?valueRenderOption=FormattedValue`, token);
  return r.data?.valueRange?.values || [];
}

function buildRecords(wsRows, jkRows) {
  // 项目维度: B组 C日期 D消耗 E收入(后面的累计列已废弃)
  // 先按组累加算组级累计ROI(从旧到新)
  const grpData = {};  // grp → [{serial, sp, rev}]
  jkRows.forEach(x => {
    if (!x[0] || !x[1]) return;
    const s = ser(x[1]) || pnum(x[1]);  // C列写的是 serial 数字
    if (!s) return;
    (grpData[x[0]] = grpData[x[0]] || []).push({ serial: s, sp: pnum(x[2]), rev: pnum(x[3]) });
  });
  // 每组按日期升序累加 → grpCumRoi["grp|serial"] = cumRoi
  const grpCumRoi = {};
  for (const [grp, entries] of Object.entries(grpData)) {
    entries.sort((a, b) => a.serial - b.serial);
    let cs = 0, cr = 0;
    for (const e of entries) { cs += e.sp; cr += e.rev; grpCumRoi[`${grp}|${e.serial}`] = cs ? cr / cs : 0; }
  }
  // byDateGrp: serial(string) → [{grp, sp, rev, cumRoi}]
  const byDateGrp = {};
  jkRows.forEach(x => {
    if (!x[0] || !x[1]) return;
    const s = ser(x[1]) || pnum(x[1]);
    if (!s) return;
    const key = String(s);
    const cumRoi = grpCumRoi[`${x[0]}|${s}`] || 0;
    (byDateGrp[key] = byDateGrp[key] || []).push({ grp: x[0], sp: pnum(x[2]), rev: pnum(x[3]), cumRoi });
  });

  // 日经营: A日期 B消耗 C收入 D当日ROAS E(废弃) F(废弃) G(废弃) H新增
  // 累计ROI 在此从每日数据自行计算(wAsSso 不再存累计列)
  const days = wsRows.filter(x => x[0] && ser(x[0]))
    .map(x => ({ date: x[0], sp: pnum(x[1]), rev: pnum(x[2]), adRoas: ppct(x[3]), nu: pnum(x[7]) }))
    .sort((a, b) => ser(b.date) - ser(a.date));
  // 从旧到新累加算全局累计ROI
  let cumSp = 0, cumRev = 0;
  [...days].reverse().forEach(d => { cumSp += d.sp; cumRev += d.rev; d.cumROI = cumSp ? cumRev / cumSp : 0; });

  return days.map((d, i) => {
    const prev = days[i + 1];
    const dayRoi = d.sp ? d.rev / d.sp : 0;
    const spChg = prev && prev.sp ? (d.sp - prev.sp) / prev.sp : null;
    const pending = d.rev <= 0 && d.sp > 0;            // 产品收入未结算
    const grps = byDateGrp[String(ser(d.date))] || [];
    const active = grps.filter(g => g.sp > 0);
    const top = [...grps].sort((a, b) => b.sp - a.sp)[0];

    const risks = [];
    if (pending) risks.push('📊产品收入待结算(16点后更新)');
    else {
      // 组级拖累:消耗较大但累计ROI明显低于整体
      grps.filter(g => g.sp > 50 && g.cumRoi > 0 && g.cumRoi < d.cumROI * 0.6)
        .forEach(g => risks.push(`🔴${g.grp}累计ROI${f2(g.cumRoi)}拖累`));
      if (d.cumROI > 0 && d.cumROI < 0.5) risks.push(`🔴整体累计ROI${f2(d.cumROI)}偏低`);
    }
    // 消耗骤变只在有规模时才算异常(过滤起量初期小基数的巨大百分比噪音)
    if (spChg != null && spChg > 0.5 && d.sp > 100) risks.push(`⚠️消耗骤增${pc(spChg)}`);
    if (spChg != null && spChg < -0.4 && prev && prev.sp > 100) risks.push(`⚠️消耗骤降${pc(spChg)}`);

    const summary = `消耗¥${f1(d.sp)}${spChg != null ? `(${pc(spChg)})` : ''}, 新增${Math.round(d.nu)}, `
      + (pending ? '今日收入待结算' : `当日ROI${f2(dayRoi)}`)
      + `, 累计ROI${f2(d.cumROI)}${top ? `, ${top.grp}领投` : ''}`;

    return {
      fields: {
        '日期': ser(d.date) * 864e5,                    // datetime(ms) → 图表按日期轴
        '消耗': f1(d.sp),
        '收入': f1(d.rev),
        '营收ROI': pending ? 0 : f2(dayRoi),            // 当日营收/消耗
        '投放ROI': f2(d.adRoas),                        // 投放原表 ROAS(消耗加权)
        '累计ROI': f2(d.cumROI),
        '消耗环比': spChg == null ? '-' : pc(spChg),
        '新增用户': Math.round(d.nu),
        '在投项目数': active.length,
        '消耗最高': top ? `${top.grp} ¥${f1(top.sp)}` : '-',
        '风险提示': risks.length ? risks.join('; ') : '✅正常',
        '经营概要': summary,
      },
    };
  });
}

const FIELDS = [
  { field_name: '日期', type: 5 },
  { field_name: '消耗', type: 2 }, { field_name: '收入', type: 2 },
  { field_name: '营收ROI', type: 2 }, { field_name: '投放ROI', type: 2 }, { field_name: '累计ROI', type: 2 },
  { field_name: '消耗环比', type: 1 }, { field_name: '新增用户', type: 2 },
  { field_name: '在投项目数', type: 2 }, { field_name: '消耗最高', type: 1 },
  { field_name: '风险提示', type: 1 }, { field_name: '经营概要', type: 1 },
];

async function listTables(token) {
  const r = await api('GET', `/open-apis/bitable/v1/apps/${BASE}/tables?page_size=100`, token);
  return (r.data?.items || []);
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

// 从 tiktok-analytics 的 D1 导出接口取数(干净的 API 真值),替代读飞书衍生表。
// 返回 ws(同 wAsSso A-H)/jk(同 JIKPZV B-E),buildRecords 不变。
function fetchD1(path) {
  const base = process.env.ANALYTICS_URL, token = process.env.EXPORT_TOKEN;
  if (!base || !token) throw new Error('缺少 ANALYTICS_URL / EXPORT_TOKEN(D1 导出依赖)');
  const u = new URL(`${base}${path}${path.includes('?') ? '&' : '?'}token=${token}`);
  return new Promise((res, rej) => {
    const r = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'GET', timeout: 25000 }, rs => {
      const c = []; rs.on('data', x => c.push(x));
      rs.on('end', () => { try { res(JSON.parse(Buffer.concat(c).toString('utf8'))); } catch (e) { rej(new Error('export 非 JSON: ' + Buffer.concat(c).toString('utf8').slice(0, 120))); } });
    });
    r.on('timeout', () => { r.destroy(); rej(new Error('export TIMEOUT')); });
    r.on('error', rej); r.end();
  });
}

async function main() {
  const token = await getFeishuToken();
  // 数据源 = D1 导出(API 真值),不再读飞书衍生表 → 根治翻倍、自动含新项目
  const ex = await fetchD1('/api/export/overview');
  if (!ex.ok) throw new Error('export overview 失败: ' + JSON.stringify(ex).slice(0, 120));
  const { ws, jk } = ex;
  const recs = buildRecords(ws, jk);
  if (!recs.length) { console.log('无数据'); return; }

  let tid = (await listTables(token)).find(x => x.name === TABLE_NAME)?.table_id;
  if (!tid) {
    const cr = await api('POST', `/open-apis/bitable/v1/apps/${BASE}/tables`, token, { table: { name: TABLE_NAME, fields: FIELDS } });
    tid = cr.data?.table_id; console.log(`新建表 ${tid}`);
  }

  // upsert by 日期:历史记录永久保留,当天数据更新
  let all = [], pt = '';
  do {
    const r = await api('GET', `/open-apis/bitable/v1/apps/${BASE}/tables/${tid}/records?page_size=500${pt ? '&page_token=' + pt : ''}`, token);
    (r.data?.items || []).forEach(x => all.push(x)); pt = r.data?.has_more ? r.data.page_token : '';
  } while (pt);
  const existMap = {};
  all.forEach(x => { existMap[String(x.fields['日期'] ?? '')] = x.record_id; });
  const toUpdate = [], toCreate = [];
  recs.forEach(rec => {
    const k = String(rec.fields['日期'] ?? '');
    if (existMap[k]) toUpdate.push({ record_id: existMap[k], fields: rec.fields });
    else toCreate.push(rec);
  });
  let updated = 0, created = 0;
  for (let i = 0; i < toUpdate.length; i += 200) {
    const w = await api('POST', `/open-apis/bitable/v1/apps/${BASE}/tables/${tid}/records/batch_update`, token, { records: toUpdate.slice(i, i + 200) });
    if (w.code === 0) updated += Math.min(200, toUpdate.length - i);
  }
  for (let i = 0; i < toCreate.length; i += 200) {
    const w = await api('POST', `/open-apis/bitable/v1/apps/${BASE}/tables/${tid}/records/batch_create`, token, { records: toCreate.slice(i, i + 200) });
    if (w.code !== 0) throw new Error('write: ' + JSON.stringify(w));
    created += Math.min(200, toCreate.length - i);
  }
  console.log(`✅ 经营概览 更新${updated}+新增${created}天(历史累计)`);
}

if (require.main === module) main().catch(e => { console.error('ERR', e.message); process.exit(1); });
module.exports = { buildRecords, main };
