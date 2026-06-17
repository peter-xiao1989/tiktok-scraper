#!/usr/bin/env node
// 数据新鲜度检查：验证多维表关键表里有「昨日」的行，否则飞书告警。
// 在 sync-bitable 完成后运行，确保数据真正落到了 Bitable，而不只是 workflow 显示 success。
const https = require('https');
const { getFeishuToken } = require('./build-summaries');

const BASE    = process.env.OVERVIEW_BASE || 'YB8TbS45kaO1gesMtqlc8kpznEb';
const WEBHOOK = process.env.FEISHU_WEBHOOK;

// 要检查的表和日期字段
const CHECKS = [
  { name: '日经营数据汇总', field: '统计周期' },
  { name: '【经营日报】-项目维度', field: '统计周期' },
];

function bjtYesterday() {
  const d = new Date(Date.now() + 8 * 3600e3 - 864e5);
  return d.toISOString().slice(0, 10);
}

function dateToSerial(s) {
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 864e5) : null;
}

async function once(method, path, token, body) {
  return new Promise((res, rej) => {
    const d = body ? JSON.stringify(body) : null;
    const h = { 'Content-Type': 'application/json' };
    if (token) h.Authorization = 'Bearer ' + token;
    if (d) h['Content-Length'] = Buffer.byteLength(d);
    const r = https.request({ hostname: 'open.feishu.cn', path, method, headers: h, timeout: 30000 }, rs => {
      const c = []; rs.on('data', x => c.push(x));
      rs.on('end', () => { try { res(JSON.parse(Buffer.concat(c).toString())); } catch { res({}); } });
    });
    r.on('timeout', () => { r.destroy(); rej(new Error('TIMEOUT')); });
    r.on('error', rej);
    if (d) r.write(d);
    r.end();
  });
}

async function api(method, path, token, body) {
  const wait = a => new Promise(s => setTimeout(s, Math.min(8000, 400 * 2 ** a)));
  for (let a = 0; ; a++) {
    let r; try { r = await once(method, path, token, body); } catch (e) { if (a >= 5) throw e; await wait(a); continue; }
    if (r && [90217, 90235].includes(r.code) && a < 5) { await wait(a); continue; }
    return r;
  }
}

function sendAlert(text) {
  if (!WEBHOOK) { console.log('⚠️ 无 FEISHU_WEBHOOK，跳过告警'); return Promise.resolve(); }
  return new Promise(resolve => {
    try {
      const u = new URL(WEBHOOK);
      const body = JSON.stringify({ msg_type: 'text', content: { text } });
      const req = https.request(
        { hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
        res => { res.on('data', () => {}); res.on('end', resolve); }
      );
      req.on('error', () => resolve());
      req.write(body); req.end();
    } catch { resolve(); }
  });
}

async function main() {
  const yesterday = bjtYesterday();
  const targetSerial = dateToSerial(yesterday);
  console.log(`检查数据新鲜度: 目标日期 ${yesterday} (serial ${targetSerial})`);

  const token = await getFeishuToken();
  const tables = (await api('GET', `/open-apis/bitable/v1/apps/${BASE}/tables?page_size=100`, token)).data?.items || [];

  const stale = [];

  for (const { name, field } of CHECKS) {
    const tbl = tables.find(t => t.name === name);
    if (!tbl) { console.log(`  ⚠️ ${name}: 表不存在`); stale.push(`${name}（表不存在）`); continue; }

    // 不依赖排序(GET 接口 sort 参数格式不可靠,曾导致读到最旧行→误报)。
    // 直接全表分页扫描,匹配目标日期。表只有几十~几百行,成本可忽略。
    let found = false, pageToken = '';
    for (let guard = 0; guard < 50 && !found; guard++) {
      const qs = `page_size=500${pageToken ? '&page_token=' + encodeURIComponent(pageToken) : ''}`;
      const r = await api('GET',
        `/open-apis/bitable/v1/apps/${BASE}/tables/${tbl.table_id}/records?${qs}`, token);
      const records = r.data?.items || [];
      for (const rec of records) {
        const v = rec.fields[field];
        if (v == null) continue;
        // Bitable 日期字段存毫秒时间戳
        const s = typeof v === 'number' ? Math.round(v / 864e5) : dateToSerial(String(v));
        if (s === targetSerial) { found = true; break; }
      }
      if (!r.data?.has_more) break;
      pageToken = r.data.page_token;
    }

    if (found) {
      console.log(`  ✅ ${name}: ${yesterday} 数据已到位`);
    } else {
      console.log(`  ❌ ${name}: 缺少 ${yesterday} 数据`);
      stale.push(name);
    }
  }

  if (stale.length > 0) {
    const bjt = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
    const msg = [
      `🔴 数据新鲜度告警 (${bjt} BJT)`,
      `昨日(${yesterday})数据未同步到多维表:`,
      stale.map(n => `  · ${n}`).join('\n'),
      `\n可能原因: ads-pull 超时 / maintainAllDerived 未完成 / chanpin sync 失败`,
      `请手动触发: daily-ads (target_date=${yesterday}) + daily-reports (chanpin)`,
    ].join('\n');
    await sendAlert(msg);
    console.log('🔴 已发送告警到飞书');
    process.exit(1);
  } else {
    console.log(`✅ 数据新鲜度检查通过 (${yesterday})`);
  }
}

main().catch(e => { console.error('check-freshness ERR:', e.message); process.exit(1); });
