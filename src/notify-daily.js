#!/usr/bin/env node
/**
 * 飞书群日报推送 — 从 JIKPZV(项目维度) + wAsSso(日经营) 读昨日数据,
 * 按项目组路由到对应群 webhook,未配置则降级通用群。
 *
 * 用法:
 *   node src/notify-daily.js [all|战车|齿轮|...]
 *
 * Secrets (GitHub Actions 或本地 env):
 *   FEISHU_WEBHOOK             — 通用/兜底群
 *   FEISHU_WEBHOOK_ZHANCHE     — 战车项目群
 *   FEISHU_WEBHOOK_CHILUN      — 齿轮项目群
 *   FEISHU_WEBHOOK_TANCHISHE   — 贪吃蛇项目群
 *   (其余项目组降级通用群)
 */

const https = require('https');
const { getFeishuToken, readColsAll, pnum, ppct, dateToSerial } = require('./build-summaries');

const SS = 'J8mswO2vziyIAAkdt4rcVeaDnog';

// 项目组 → webhook env 名 (env 值来自 GitHub Secrets,代码里不存明文)
const WEBHOOK_MAP = {
  '战车':    'FEISHU_WEBHOOK_ZHANCHE',
  '齿轮':    'FEISHU_WEBHOOK_CHILUN',
  '贪吃蛇':  'FEISHU_WEBHOOK_TANCHISHE',
  // 新增项目组:在这里加一行 + 配对应 Secret
};
const FALLBACK_WEBHOOK_ENV = 'FEISHU_WEBHOOK';

// ─── HTTP 推送 ─────────────────────────────────────────────────────────────

function sendWebhook(url, text) {
  return new Promise(resolve => {
    try {
      const u = new URL(url);
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

function getWebhookUrl(group) {
  const envName = WEBHOOK_MAP[group];
  const url = (envName && process.env[envName]) || process.env[FALLBACK_WEBHOOK_ENV];
  return url || null;
}

// ─── 日期工具 ──────────────────────────────────────────────────────────────

function bjtToday() {
  return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
}

function bjtYesterday() {
  return new Date(Date.now() + 8 * 3600e3 - 864e5).toISOString().slice(0, 10);
}

function formatDate(d) {
  // YYYY-MM-DD → MM-DD
  return d.slice(5);
}

const f1 = v => Math.round(v * 10) / 10;
const f2 = v => Math.round(v * 100) / 100;
const pct = v => Math.round(v * 100) + '%';
const sign = v => (v >= 0 ? '+' : '') + Math.round(v * 100) + '%';

// ─── 数据读取 ──────────────────────────────────────────────────────────────

async function readJIKPZV(token) {
  // JIKPZV: A序号 B项目组 C统计周期(serial) D消耗 E收入 F广告首日ROI ... H新增用户
  const rows = await readColsAll(token, 'JIKPZV', 'B', 'I');
  // B=0组 C=1统计周期 D=2消耗 E=3收入 F=4广告首日ROI G=5累计消耗(空) H=6累计收入(空) I=7新增用户
  return rows;
}

async function readWAsSso(token) {
  // wAsSso: A统计周期 B消耗 C收入 D当日ROAS ... H新增用户
  const rows = await readColsAll(token, 'wAsSso', 'A', 'H');
  return rows;
}

// ─── 数据聚合 ──────────────────────────────────────────────────────────────

function aggregateDaily(jkRows, wsRows, targetDate) {
  const targetSerial = dateToSerial(targetDate);
  if (!targetSerial) return null;

  // 日总量从 wAsSso (A=统计周期)
  const ws = wsRows.find(r => {
    const v = r[0];
    if (v == null || v === '') return false;
    const s = /^\d{5}(\.\d+)?$/.test(String(v).trim()) ? Math.round(+v) : dateToSerial(String(v));
    return s === targetSerial;
  });
  const totalSpend = ws ? pnum(ws[1]) : 0;
  const totalRev   = ws ? pnum(ws[2]) : 0;
  const totalNu    = ws ? pnum(ws[7]) : 0;
  const dayRoi     = totalSpend > 0 ? totalRev / totalSpend : 0;

  // 按项目组聚合 (JIKPZV B=0组 C=1serial D=2消耗 E=3收入 H=7新增)
  const byGroup = {};
  for (const r of jkRows) {
    const grp = r[0];
    if (!grp) continue;
    const v = r[1];
    const s = /^\d{5}(\.\d+)?$/.test(String(v == null ? '' : v).trim()) ? Math.round(+v) : dateToSerial(String(v == null ? '' : v));
    if (s !== targetSerial) continue;
    const g = byGroup[grp] = byGroup[grp] || { sp: 0, rev: 0, nu: 0 };
    g.sp  += pnum(r[2]);
    g.rev += pnum(r[3]);
    g.nu  += pnum(r[7]);
  }

  // 昨日 (targetDate 前一天) 的项目组数据,用于环比
  const prevDate = new Date(new Date(targetDate + 'T00:00:00Z').getTime() - 864e5).toISOString().slice(0, 10);
  const prevSerial = dateToSerial(prevDate);
  const prevByGroup = {};
  for (const r of jkRows) {
    const grp = r[0];
    if (!grp) continue;
    const v = r[1];
    const s = /^\d{5}(\.\d+)?$/.test(String(v == null ? '' : v).trim()) ? Math.round(+v) : dateToSerial(String(v == null ? '' : v));
    if (s !== prevSerial) continue;
    const g = prevByGroup[grp] = prevByGroup[grp] || { sp: 0, rev: 0, nu: 0 };
    g.sp  += pnum(r[2]);
    g.rev += pnum(r[3]);
    g.nu  += pnum(r[7]);
  }

  // 前日总量
  const prevWs = wsRows.find(r => {
    const v = r[0];
    if (v == null || v === '') return false;
    const s = /^\d{5}(\.\d+)?$/.test(String(v).trim()) ? Math.round(+v) : dateToSerial(String(v));
    return s === prevSerial;
  });
  const prevTotalSpend = prevWs ? pnum(prevWs[1]) : 0;
  const prevTotalRev   = prevWs ? pnum(prevWs[2]) : 0;

  return { targetDate, totalSpend, totalRev, totalNu, dayRoi, byGroup, prevByGroup, prevTotalSpend, prevTotalRev };
}

// ─── 消息格式化 ────────────────────────────────────────────────────────────

function formatGroupMsg(group, data, dateLabel) {
  const g = data.byGroup[group];
  if (!g || g.sp <= 0) return null;
  const prev = data.prevByGroup[group] || { sp: 0, rev: 0, nu: 0 };
  const roi = g.sp > 0 ? g.rev / g.sp : 0;
  const spChg = prev.sp > 0 ? (g.sp - prev.sp) / prev.sp : null;
  const revChg = prev.rev > 0 ? (g.rev - prev.rev) / prev.rev : null;
  const pending = g.rev <= 0 && g.sp > 0;

  const lines = [
    `📊 ${group} ${dateLabel} 日报`,
    `消耗 ¥${f1(g.sp)}${spChg !== null ? ` (${sign(spChg)})` : ''}  收入 ${pending ? '待结算' : `¥${f1(g.rev)}${revChg !== null ? ` (${sign(revChg)})` : ''}`}`,
    `当日ROI: ${pending ? '-' : f2(roi)}  新增: ${Math.round(g.nu)}`,
  ];
  if (pending) lines.push('⚠️ 产品收入 T+1 结算,16点后更新');
  return lines.join('\n');
}

function formatTotalMsg(data, dateLabel) {
  const { totalSpend, totalRev, totalNu, dayRoi, prevTotalSpend, prevTotalRev } = data;
  const pending = totalRev <= 0 && totalSpend > 0;
  const spChg = prevTotalSpend > 0 ? (totalSpend - prevTotalSpend) / prevTotalSpend : null;
  const revChg = prevTotalRev > 0 ? (totalRev - prevTotalRev) / prevTotalRev : null;
  const groups = Object.entries(data.byGroup)
    .filter(([, g]) => g.sp > 0)
    .sort(([, a], [, b]) => b.sp - a.sp)
    .map(([name, g]) => `  ${name} ¥${f1(g.sp)}`)
    .join('\n');

  const lines = [
    `📊 经营日报 ${dateLabel}`,
    `消耗 ¥${f1(totalSpend)}${spChg !== null ? ` (${sign(spChg)})` : ''}`,
    `收入 ${pending ? '待结算' : `¥${f1(totalRev)}${revChg !== null ? ` (${sign(revChg)})` : ''}`}`,
    `当日ROI: ${pending ? '-' : f2(dayRoi)}  新增: ${Math.round(totalNu)}`,
  ];
  if (groups) lines.push('各项目组消耗:\n' + groups);
  if (pending) lines.push('⚠️ 产品收入 T+1 结算,16点后更新');
  return lines.join('\n');
}

// ─── 主流程 ────────────────────────────────────────────────────────────────

async function main() {
  const target = process.argv[2] || 'all';
  const reportDate = process.env.REPORT_DATE || bjtYesterday();
  const dateLabel = formatDate(reportDate);

  const fallbackUrl = process.env[FALLBACK_WEBHOOK_ENV];
  if (!fallbackUrl) {
    // 尝试检查是否有任何项目群配置
    const hasAny = Object.values(WEBHOOK_MAP).some(e => process.env[e]);
    if (!hasAny) {
      console.log('未配置任何 FEISHU_WEBHOOK*,跳过日报推送');
      return;
    }
  }

  const token = await getFeishuToken();
  const [jkRows, wsRows] = await Promise.all([readJIKPZV(token), readWAsSso(token)]);

  const data = aggregateDaily(jkRows, wsRows, reportDate);
  if (!data) { console.log('无数据'); return; }

  const groups = Object.keys(data.byGroup).filter(g => data.byGroup[g].sp > 0);

  if (target === 'all') {
    // 先推总览到通用群
    if (fallbackUrl) {
      const msg = formatTotalMsg(data, dateLabel);
      await sendWebhook(fallbackUrl, msg);
      console.log(`✅ 总览日报已推送 → 通用群`);
    }
    // 再按项目组推各自的群
    for (const grp of groups) {
      const url = getWebhookUrl(grp);
      if (!url) { console.log(`  ${grp}: 无独立 webhook,已含在总览中`); continue; }
      if (url === fallbackUrl) { console.log(`  ${grp}: webhook = 通用群,跳过重复发送`); continue; }
      const msg = formatGroupMsg(grp, data, dateLabel);
      if (!msg) continue;
      await sendWebhook(url, msg);
      console.log(`✅ ${grp} 日报已推送`);
    }
  } else {
    // 单项目组模式
    const url = getWebhookUrl(target) || fallbackUrl;
    if (!url) { console.log(`无可用 webhook,跳过`); return; }
    const msg = target === '总览'
      ? formatTotalMsg(data, dateLabel)
      : formatGroupMsg(target, data, dateLabel);
    if (!msg) { console.log(`${target} 无当日数据`); return; }
    await sendWebhook(url, msg);
    console.log(`✅ ${target} 日报已推送`);
  }
}

if (require.main === module) {
  main().catch(e => { console.error('notify-daily ERR:', e.message); process.exit(1); });
}

module.exports = { aggregateDaily, formatGroupMsg, formatTotalMsg };
