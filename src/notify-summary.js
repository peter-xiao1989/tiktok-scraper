#!/usr/bin/env node
/**
 * 飞书群周/月汇总推送 — 从 JIKPZV(项目维度) + wAsSso(日经营) 读指定时间段数据。
 *
 * 用法:
 *   node src/notify-summary.js weekly          # 上周 Mon-Sun
 *   node src/notify-summary.js monthly         # 上月
 *   node src/notify-summary.js weekly 2026-W24 # 指定周(ISO周)
 *   node src/notify-summary.js monthly 2026-05 # 指定月
 *
 * Webhook Secrets:
 *   FEISHU_WEBHOOK             — 通用/兜底群
 *   FEISHU_WEBHOOK_ZHANCHE     — 战车
 *   FEISHU_WEBHOOK_CHILUN      — 齿轮
 *   FEISHU_WEBHOOK_TANCHISHE   — 贪吃蛇
 */

const https = require('https');
const { getFeishuToken, readColsAll, pnum, dateToSerial } = require('./build-summaries');

const WEBHOOK_MAP = {
  '战车':   'FEISHU_WEBHOOK_ZHANCHE',
  '齿轮':   'FEISHU_WEBHOOK_CHILUN',
  '贪吃蛇': 'FEISHU_WEBHOOK_TANCHISHE',
};
const FALLBACK_WEBHOOK_ENV = 'FEISHU_WEBHOOK';

// ─── 日期工具 ──────────────────────────────────────────────────────────────

function bjtNow() {
  return new Date(Date.now() + 8 * 3600e3);
}

// 返回 { start, end } 字符串 YYYY-MM-DD,上周 Mon–Sun (BJT)
function lastWeekRange() {
  const now = bjtNow();
  // day: 0=Sun,1=Mon,...,6=Sat
  const day = now.getUTCDay();
  // days since last Monday = (day + 6) % 7 + 7  (至少回退7天到上周一)
  const daysToLastMon = (day + 6) % 7 + 7;
  const mon = new Date(now.getTime() - daysToLastMon * 864e5);
  const sun = new Date(mon.getTime() + 6 * 864e5);
  return {
    start: mon.toISOString().slice(0, 10),
    end:   sun.toISOString().slice(0, 10),
    label: `W${isoWeek(mon)}(${fmd(mon)}~${fmd(sun)})`,
  };
}

// 返回上月范围
function lastMonthRange() {
  const now = bjtNow();
  const y = now.getUTCFullYear(), m = now.getUTCMonth(); // m 0-indexed
  const lastM = m === 0 ? 12 : m;
  const lastY = m === 0 ? y - 1 : y;
  const start = `${lastY}-${String(lastM).padStart(2, '0')}-01`;
  const lastDay = new Date(Date.UTC(lastY, lastM, 0)).getUTCDate();
  const end = `${lastY}-${String(lastM).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { start, end, label: `${lastY}年${lastM}月` };
}

// ISO 周号
function isoWeek(d) {
  const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = tmp.getUTCDay() || 7;
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  return Math.ceil((((tmp - yearStart) / 864e5) + 1) / 7);
}

// 格式 MM/DD
function fmd(d) {
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
}

// 解析 "2026-W24" 或 "2026-05"
function parseRange(mode, arg) {
  if (!arg) return mode === 'weekly' ? lastWeekRange() : lastMonthRange();
  if (mode === 'weekly') {
    const m = /^(\d{4})-W(\d{1,2})$/.exec(arg);
    if (!m) throw new Error(`无效周格式: ${arg} (expected YYYY-WNN)`);
    const [, y, w] = m;
    // ISO 周一 = 该年第一个周四所在周的周一
    const jan4 = new Date(Date.UTC(+y, 0, 4));
    const dayOfWeek = jan4.getUTCDay() || 7;
    const mon = new Date(jan4.getTime() - (dayOfWeek - 1) * 864e5 + (+w - 1) * 7 * 864e5);
    const sun = new Date(mon.getTime() + 6 * 864e5);
    return { start: mon.toISOString().slice(0, 10), end: sun.toISOString().slice(0, 10), label: `第${w}周(${fmd(mon)}~${fmd(sun)})` };
  } else {
    const m = /^(\d{4})-(\d{1,2})$/.exec(arg);
    if (!m) throw new Error(`无效月格式: ${arg} (expected YYYY-MM)`);
    const [, y, mo] = m;
    const start = `${y}-${String(+mo).padStart(2, '0')}-01`;
    const lastDay = new Date(Date.UTC(+y, +mo, 0)).getUTCDate();
    const end = `${y}-${String(+mo).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    return { start, end, label: `${y}年${+mo}月` };
  }
}

const f1 = v => Math.round(v * 10) / 10;
const f2 = v => Math.round(v * 100) / 100;

// ─── 数据聚合 ──────────────────────────────────────────────────────────────

function aggregateRange(jkRows, wsRows, start, end) {
  const startS = dateToSerial(start);
  const endS   = dateToSerial(end);
  if (!startS || !endS) return null;

  // 按项目组聚合
  const byGroup = {};
  for (const r of jkRows) {
    const grp = r[0];
    if (!grp) continue;
    const v = r[1];
    const s = /^\d{5}(\.\d+)?$/.test(String(v == null ? '' : v).trim()) ? Math.round(+v) : dateToSerial(String(v == null ? '' : v));
    if (!s || s < startS || s > endS) continue;
    const g = byGroup[grp] = byGroup[grp] || { sp: 0, rev: 0, nu: 0, days: new Set() };
    g.sp  += pnum(r[2]);
    g.rev += pnum(r[3]);
    g.nu  += pnum(r[7]);
    g.days.add(s);
  }

  // 每日消耗(用于找最佳日)
  const dailySpend = {};
  for (const r of wsRows) {
    const v = r[0];
    if (v == null || v === '') continue;
    const s = /^\d{5}(\.\d+)?$/.test(String(v).trim()) ? Math.round(+v) : dateToSerial(String(v));
    if (!s || s < startS || s > endS) continue;
    // serial → YYYY-MM-DD
    const isoDate = new Date((s - 25569) * 864e5).toISOString().slice(0, 10);
    dailySpend[isoDate] = pnum(r[1]);
  }

  // 总量
  let totalSp = 0, totalRev = 0, totalNu = 0;
  for (const g of Object.values(byGroup)) { totalSp += g.sp; totalRev += g.rev; totalNu += g.nu; }

  // 最佳消耗日
  const bestDay = Object.entries(dailySpend).sort(([, a], [, b]) => b - a)[0];

  return { byGroup, totalSp, totalRev, totalNu, bestDay };
}

// ─── 消息格式化 ────────────────────────────────────────────────────────────

function formatGroupSummary(group, data, label, mode) {
  const g = data.byGroup[group];
  if (!g || g.sp <= 0) return null;
  const roi = g.sp > 0 ? g.rev / g.sp : 0;
  const icon = mode === 'weekly' ? '📅' : '📆';

  return [
    `${icon} ${group} ${label}`,
    `消耗 ¥${f1(g.sp)}  收入 ¥${f1(g.rev)}`,
    `ROI: ${f2(roi)}  新增: ${Math.round(g.nu)}`,
    data.bestDay ? `最佳日: ${data.bestDay[0].slice(5)} ¥${f1(data.bestDay[1])}` : '',
  ].filter(Boolean).join('\n');
}

function formatTotalSummary(data, label, mode) {
  const { totalSp, totalRev, totalNu } = data;
  const roi = totalSp > 0 ? totalRev / totalSp : 0;
  const icon = mode === 'weekly' ? '📅' : '📆';
  const groups = Object.entries(data.byGroup)
    .filter(([, g]) => g.sp > 0)
    .sort(([, a], [, b]) => b.sp - a.sp)
    .map(([name, g]) => `  ${name} 消耗¥${f1(g.sp)} ROI:${f2(g.rev / g.sp)}`)
    .join('\n');

  return [
    `${icon} 经营${mode === 'weekly' ? '周报' : '月报'} ${label}`,
    `消耗 ¥${f1(totalSp)}  收入 ¥${f1(totalRev)}`,
    `综合ROI: ${f2(roi)}  新增: ${Math.round(totalNu)}`,
    groups ? '各项目组:\n' + groups : '',
    data.bestDay ? `最佳日: ${data.bestDay[0].slice(5)} ¥${f1(data.bestDay[1])}` : '',
  ].filter(Boolean).join('\n');
}

// ─── 推送 ─────────────────────────────────────────────────────────────────

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
  return (envName && process.env[envName]) || process.env[FALLBACK_WEBHOOK_ENV] || null;
}

// ─── 主流程 ────────────────────────────────────────────────────────────────

async function main() {
  const [, , mode = 'weekly', rangeArg] = process.argv;
  if (mode !== 'weekly' && mode !== 'monthly') {
    console.error(`用法: node src/notify-summary.js [weekly|monthly] [YYYY-WNN|YYYY-MM]`);
    process.exit(1);
  }

  const { start, end, label } = parseRange(mode, rangeArg);
  console.log(`${mode} 汇总: ${start} ~ ${end} (${label})`);

  const fallbackUrl = process.env[FALLBACK_WEBHOOK_ENV];
  const hasAny = fallbackUrl || Object.values(WEBHOOK_MAP).some(e => process.env[e]);
  if (!hasAny) { console.log('未配置任何 FEISHU_WEBHOOK*,跳过'); return; }

  const token = await getFeishuToken();
  const [jkRows, wsRows] = await Promise.all([
    readColsAll(token, 'JIKPZV', 'B', 'I'),
    readColsAll(token, 'wAsSso', 'A', 'H'),
  ]);

  const data = aggregateRange(jkRows, wsRows, start, end);
  if (!data || data.totalSp <= 0) { console.log('期间无数据'); return; }

  const groups = Object.keys(data.byGroup).filter(g => data.byGroup[g].sp > 0);

  // 总览 → 通用群
  if (fallbackUrl) {
    await sendWebhook(fallbackUrl, formatTotalSummary(data, label, mode));
    console.log(`✅ 总览${mode === 'weekly' ? '周报' : '月报'}已推送 → 通用群`);
  }

  // 各项目组 → 项目群 (有独立群的才发,否则总览已含)
  for (const grp of groups) {
    const url = getWebhookUrl(grp);
    if (!url || url === fallbackUrl) continue;
    const msg = formatGroupSummary(grp, data, label, mode);
    if (!msg) continue;
    await sendWebhook(url, msg);
    console.log(`✅ ${grp} ${mode === 'weekly' ? '周报' : '月报'}已推送`);
  }
}

if (require.main === module) {
  main().catch(e => { console.error('notify-summary ERR:', e.message); process.exit(1); });
}

module.exports = { aggregateRange, formatGroupSummary, formatTotalSummary, parseRange };
