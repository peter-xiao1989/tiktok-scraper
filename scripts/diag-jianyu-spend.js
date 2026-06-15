/**
 * 诊断监狱项目消耗数据:
 * 1. juQobR 里监狱游戏配置
 * 2. uqJEhq 里 2026-06-13 监狱相关游戏的消耗
 * 3. JIKPZV 里监狱 2026-06-13 行的消耗
 */
const https = require('https');
const { getFeishuToken } = require('../src/build-summaries');
const SS = 'J8mswO2vziyIAAkdt4rcVeaDnog';

function req(m, p, t) {
  return new Promise((res, rej) => {
    const h = { 'Content-Type': 'application/json' }; if (t) h.Authorization = 'Bearer ' + t;
    const r = https.request({ hostname: 'open.feishu.cn', path: p, method: m, headers: h, timeout: 30000 }, rs => {
      const c = []; rs.on('data', x => c.push(x));
      rs.on('end', () => { try { res(JSON.parse(Buffer.concat(c).toString())); } catch { res({}); } });
    });
    r.on('timeout', () => { r.destroy(); rej(new Error('timeout')); }); r.on('error', rej); r.end();
  });
}
async function readSheet(token, range) {
  const r = await req('GET', `/open-apis/sheets/v2/spreadsheets/${SS}/values/${range}?valueRenderOption=FormattedValue`, token);
  return r.data?.valueRange?.values || [];
}

async function main() {
  const token = await getFeishuToken();

  // 1. juQobR 监狱游戏
  const roster = await readSheet(token, 'juQobR!A2:B200');
  const jianyuGames = roster.filter(r => String(r[0] || '').trim() === '监狱').map(r => String(r[1] || '').trim());
  console.log('\n=== juQobR 监狱游戏配置 ===');
  console.log(jianyuGames.length ? jianyuGames : '(无)');

  // 2. uqJEhq June 13 游戏名 & 消耗
  const ads = await readSheet(token, 'uqJEhq!B2:F5000');
  const june13Ads = ads.filter(r => String(r[2] || '').includes('2026-06-13') || String(r[2] || '').includes('2026/06/13'));
  const jianyuJune13 = june13Ads.filter(r => jianyuGames.includes(String(r[0] || '').trim()));
  console.log('\n=== uqJEhq 2026-06-13 监狱游戏行数 ===', jianyuJune13.length);
  const totalSpend = jianyuJune13.reduce((s, r) => s + (parseFloat(String(r[3] || '').replace(/[,%]/g, '')) || 0), 0);
  console.log('合计消耗:', totalSpend.toFixed(1));
  if (jianyuJune13.length) {
    console.log('样本(前3):', jianyuJune13.slice(0, 3).map(r => `${r[0]} 消耗=${r[3]}`));
  }

  // 3. JIKPZV 监狱 June 13
  const jikpzv = await readSheet(token, 'JIKPZV!A1:H2000');
  const hdr = jikpzv[0].map(v => String(v || '').trim());
  const gi = hdr.indexOf('项目组'), di = hdr.indexOf('统计周期'), si = hdr.indexOf('消耗');
  const jkRow = jikpzv.slice(1).find(r => String(r[gi] || '').trim() === '监狱' && (String(r[di] || '').includes('2026-06-13') || String(r[di] || '').includes('2026/06/13')));
  console.log('\n=== JIKPZV 监狱 2026-06-13 ===');
  if (jkRow) {
    console.log('项目组:', jkRow[gi], '日期:', jkRow[di], '消耗:', jkRow[si]);
  } else {
    console.log('未找到该行');
    // 列出所有监狱行
    const allJY = jikpzv.slice(1).filter(r => String(r[gi] || '').trim() === '监狱');
    console.log('监狱所有行日期:', allJY.slice(0, 5).map(r => r[di]));
  }

  // 4. June 13 所有游戏名 样本(看是否有拼写不一样的监狱游戏)
  const june13Games = [...new Set(june13Ads.map(r => String(r[0] || '').trim()))].filter(Boolean);
  console.log('\n=== uqJEhq 2026-06-13 所有游戏名 ===');
  console.log(june13Games.slice(0, 20));
}

main().catch(e => { console.error('ERR:', e.message); process.exit(1); });
