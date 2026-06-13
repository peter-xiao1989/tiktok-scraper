#!/usr/bin/env node
// 产品数据缺口检测:对比 juQobR(期望游戏) vs c50205(实际数据),
// 输出近 N 天每个游戏/日期的缺口,并推送飞书告警。
// 不做自动修复(产品数据来自 portal scraper,需要浏览器 auth,只能人工触发 workflow)。
// 挂 daily-product workflow(导入后运行),缺口时告警。
const https = require('https');

const SS = 'J8mswO2vziyIAAkdt4rcVeaDnog';
const FEISHU_APP_ID = process.env.FEISHU_APP_ID || 'cli_aa898a664d395cc2';
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || (() => { throw new Error('FEISHU_APP_SECRET required'); })();
const DAYS = parseInt(process.env.AUDIT_PRODUCT_DAYS || '14', 10);

function req(method, path, token, body) {
  return new Promise((res, rej) => {
    const d = body ? JSON.stringify(body) : null;
    const h = { 'Content-Type': 'application/json' };
    if (token) h.Authorization = 'Bearer ' + token;
    if (d) h['Content-Length'] = Buffer.byteLength(d);
    const r = https.request({ hostname: 'open.feishu.cn', path, method, headers: h, timeout: 30000 }, rs => {
      const c = []; rs.on('data', x => c.push(x));
      rs.on('end', () => { try { res(JSON.parse(Buffer.concat(c).toString())); } catch (e) { rej(e); } });
    });
    r.on('timeout', () => { r.destroy(); rej(new Error('timeout')); }); r.on('error', rej);
    if (d) r.write(d); r.end();
  });
}
const wait = n => new Promise(s => setTimeout(s, n));
async function feishu(method, path, token, body) {
  for (let a = 0; ; a++) {
    try {
      const r = await req(method, path, token, body);
      if (r && (r.code === 90217 || r.code === 90235) && a < 6) { await wait(500 * 2 ** a); continue; }
      return r;
    } catch (e) { if (a >= 6) throw e; await wait(500 * 2 ** a); }
  }
}

function toISO(v) {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  const n = parseFloat(v);
  if (!isNaN(n) && n > 40000) return new Date(Math.round((n - 25569) * 86400000)).toISOString().slice(0, 10);
  return null;
}

async function readAll(token, sheetId, range) {
  const r = await feishu('GET', `/open-apis/sheets/v2/spreadsheets/${SS}/values/${sheetId}!${range}?valueRenderOption=FormattedValue`, token);
  return (r.data?.valueRange?.values || []).filter(x => x && x.some(v => v != null && v !== ''));
}

async function main() {
  const ft = (await feishu('POST', '/open-apis/auth/v3/tenant_access_token/internal', null,
    { app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET })).tenant_access_token;

  // 期望游戏列表(juQobR A=项目组 B=产品名 C=id,无id跳过)
  const roster = await readAll(ft, 'juQobR', 'A2:C500');
  const expectedGames = new Set(
    roster.filter(r => r[2] && String(r[2]).trim()).map(r => String(r[1] || '').trim()).filter(Boolean)
  );
  console.log(`expected games: ${expectedGames.size}`);

  // 近 N 天日期范围
  const dates = [];
  for (let i = 1; i <= DAYS; i++) {
    const d = new Date(Date.now() - i * 864e5);
    dates.push(d.toISOString().slice(0, 10));
  }
  const dateSet = new Set(dates);

  // 实际数据(c50205 C=游戏名 D=日期 AB=广告总收入)
  const prodRows = await readAll(ft, 'c50205', 'C2:AB5000');
  const have = new Set();          // "game|date"
  const revenueZero = new Set();   // 有行但广告总收入=0
  for (const r of prodRows) {
    const game = String(r[0] || '').trim();
    const date = toISO(r[1]);
    if (!game || !date || !dateSet.has(date)) continue;
    const key = `${game}|${date}`;
    have.add(key);
    const rev = parseFloat(String(r[25] || '').replace(/,/g, '')) || 0;
    if (rev === 0) revenueZero.add(key);
  }

  // 找缺口
  const missing = [];   // {game, date} — 完全没有行
  const zeroRev = [];   // {game, date} — 有行但收入=0

  for (const date of dates) {
    for (const game of expectedGames) {
      const key = `${game}|${date}`;
      if (!have.has(key)) missing.push({ game, date });
      else if (revenueZero.has(key)) zeroRev.push({ game, date });
    }
  }

  console.log(`\nmissing rows: ${missing.length}`);
  console.log(`zero revenue rows: ${zeroRev.length}`);

  if (missing.length > 0) {
    console.log('\n=== 缺失行(完全没有数据) ===');
    missing.slice(0, 30).forEach(({ game, date }) => console.log(`  ${date}  ${game}`));
    if (missing.length > 30) console.log(`  ... 共 ${missing.length} 条`);
  }
  if (zeroRev.length > 0) {
    console.log('\n=== 收入为0行(有行但广告总收入=0) ===');
    zeroRev.slice(0, 20).forEach(({ game, date }) => console.log(`  ${date}  ${game}`));
    if (zeroRev.length > 20) console.log(`  ... 共 ${zeroRev.length} 条`);
  }

  // 推送飞书告警
  const webhook = process.env.FEISHU_WEBHOOK;
  if (!webhook || (missing.length === 0 && zeroRev.length === 0)) {
    console.log('\n产品数据完整,无缺口。');
    return;
  }

  // 找缺口最早日期(用于 start_date 建议)
  const gapDates = [...new Set([...missing, ...zeroRev].map(x => x.date))].sort();
  const earliestGap = gapDates[0];
  const affectedGames = [...new Set([...missing, ...zeroRev].map(x => x.game))].slice(0, 5).join(' / ');

  const lines = [
    `🟡 产品数据缺口检测 (近${DAYS}天)`,
    `缺失行: ${missing.length} 条 | 收入为0: ${zeroRev.length} 条`,
    `涉及游戏: ${affectedGames}`,
    `最早缺口: ${earliestGap}`,
    `修复: 在 GitHub Actions → daily-product workflow_dispatch 手动触发,`,
    `  填入 start_date=${earliestGap} 补录历史数据`,
  ];
  const text = lines.join('\n');
  console.log('\n' + text);

  await new Promise(resolve => {
    try {
      const u = new URL(webhook);
      const body = JSON.stringify({ msg_type: 'text', content: { text } });
      const r = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
        rs => { rs.on('data', () => {}); rs.on('end', resolve); });
      r.on('error', () => resolve()); r.write(body); r.end();
    } catch { resolve(); }
  });
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
