#!/usr/bin/env node
// 每月自动滚动经营总览仪表盘的"X月消耗/X月收入/X月广告首日ROI/累计ROI"指标卡:
// 把卡名和筛选(数据月报.月份)对齐到当前自然月。幂等,daily-reports 每天跑。
// 依赖 lark-cli(workflow 里已 config init)。
const { execFileSync } = require('child_process');

const YB = 'YB8TbS45kaO1gesMtqlc8kpznEb';
const DASH = 'blkN7iTRJwPqBFga';

function lark(args) {
  const out = execFileSync('lark-cli', ['--format', 'json', ...args], { encoding: 'utf8', timeout: 60000 });
  try { return JSON.parse(out); } catch (e) { return {}; }
}

const now = new Date(Date.now() + 8 * 3600e3);  // 北京时间
const YM = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
const M = now.getUTCMonth() + 1;

const dash = lark(['base', '+dashboard-get', '--base-token', YB, '--dashboard-id', DASH, '--as', 'bot']);
const blocks = dash.data?.dashboard?.blocks || [];
const monthFilter = kind => JSON.stringify({
  table_name: '数据月报',
  series: [{ field_name: kind === '广告首日ROI' ? '投放ROI' : kind, rollup: kind === '广告首日ROI' ? 'AVERAGE' : 'SUM' }],
  filter: { conjunction: 'and', conditions: [{ field_name: '月份', operator: 'is', value: YM }] },
});

let changed = 0;
for (const kind of ['消耗', '收入', '广告首日ROI']) {
  const b = blocks.find(x => new RegExp(`^\\d+月${kind.replace(/[()]/g, '\\$&')}$`).test(x.block_name || ''));
  if (!b) { console.log(`⏭️ 没找到 X月${kind} 卡`); continue; }
  if (b.block_name === `${M}月${kind}`) continue;  // 已是当月
  const r = lark(['base', '+dashboard-block-update', '--base-token', YB, '--dashboard-id', DASH,
    '--block-id', b.block_id, '--name', `${M}月${kind}`, '--data-config', monthFilter(kind), '--as', 'bot']);
  console.log(`${r.ok ? '✅' : '❌'} ${b.block_name} → ${M}月${kind}`);
  changed++;
}
// 累计ROI 卡:取数据月报当月行的累计ROI(月行快照=当前累计)
const roi = blocks.find(x => x.block_name === '累计ROI' && x.block_type === 'statistics');
if (roi && changed) {
  const cfg = JSON.stringify({ table_name: '数据月报', series: [{ field_name: '累计ROI', rollup: 'AVERAGE' }],
    filter: { conjunction: 'and', conditions: [{ field_name: '月份', operator: 'is', value: YM }] } });
  const r = lark(['base', '+dashboard-block-update', '--base-token', YB, '--dashboard-id', DASH,
    '--block-id', roi.block_id, '--data-config', cfg, '--as', 'bot']);
  console.log(`${r.ok ? '✅' : '❌'} 累计ROI 卡滚动到 ${YM}`);
}
console.log(changed ? `月卡已滚动到 ${M} 月` : `月卡已是 ${M} 月,无需变更`);
