const fs = require('fs');
const path = require('path');

const HEADERS = [
  '游戏名称', '统计周期', '新增用户', '活跃用户', '新增激活率',
  '总启动次数', '人均进入次数', '每位用户平均时长_分', '次均游戏时长_分',
  '平均启动速度_秒', '平均首次启动速度_秒', '次留',
  '广告曝光量', '广告点击量', '广告点击率', 'eCPM', '人均广告展示次数', '广告总收入', 'ROI',
];

function escapeField(val) {
  const s = String(val ?? '');
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"` : s;
}

function rowToCsv(row) {
  return HEADERS.map(h => escapeField(row[h])).join(',');
}

function appendRows(filePath, rows) {
  const exists = fs.existsSync(filePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = [];
  if (!exists) lines.push(HEADERS.join(','));
  rows.forEach(row => lines.push(rowToCsv(row)));
  fs.appendFileSync(filePath, lines.join('\n') + '\n', 'utf8');
}

module.exports = { appendRows, HEADERS };
