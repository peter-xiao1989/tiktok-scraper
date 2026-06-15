/**
 * 修复监狱 base：
 * 1. 把仪表盘名 "枪战经营总览" → "监狱经营总览"
 * 2. 打印表数据行数验证
 */
const https = require('https');
const { getFeishuToken } = require('../src/build-summaries');

const BASE = process.env.JIANYU_BASE || 'I9arbAocBaZIpBscT0Gc8sAYn2d';

function req(m, p, t, b) {
  return new Promise((res, rej) => {
    const d = b ? JSON.stringify(b) : null;
    const h = { 'Content-Type': 'application/json' };
    if (t) h.Authorization = 'Bearer ' + t;
    if (d) h['Content-Length'] = Buffer.byteLength(d);
    const r = https.request({ hostname: 'open.feishu.cn', path: p, method: m, headers: h, timeout: 20000 }, rs => {
      const c = []; rs.on('data', x => c.push(x));
      rs.on('end', () => { try { res(JSON.parse(Buffer.concat(c).toString())); } catch { res({}); } });
    });
    r.on('timeout', () => { r.destroy(); rej(new Error('timeout')); });
    r.on('error', rej); if (d) r.write(d); r.end();
  });
}

async function main() {
  const token = await getFeishuToken();

  // 1. 列出仪表盘
  const dash = await req('GET', `/open-apis/bitable/v1/apps/${BASE}/dashboards?page_size=20`, token);
  const items = dash.data?.items || [];
  console.log('Dashboards:', items.map(x => `${x.name} [${x.block_id}]`).join(', ') || '(none)');

  // 2. 重命名 "枪战经营总览" → "监狱经营总览"
  for (const d of items) {
    if (d.name.includes('枪战')) {
      const newName = d.name.replace(/枪战/g, '监狱');
      const r = await req('PATCH', `/open-apis/bitable/v1/apps/${BASE}/dashboards/${d.block_id}`, token, { name: newName });
      console.log(`  Rename "${d.name}" → "${newName}":`, r.code === 0 ? 'OK' : JSON.stringify(r));
    }
  }

  // 3. 验证数据
  const tbls = await req('GET', `/open-apis/bitable/v1/apps/${BASE}/tables?page_size=50`, token);
  const tables = tbls.data?.items || [];
  console.log('\nTables:');
  for (const t of tables) {
    const recs = await req('GET', `/open-apis/bitable/v1/apps/${BASE}/tables/${t.table_id}/records?page_size=1`, token);
    const total = recs.data?.total ?? '?';
    console.log(`  ${t.name}: ${total} 行`);
    // 打印第一行 项目组 字段验证是否是监狱数据
    const firstRec = recs.data?.items?.[0]?.fields;
    if (firstRec?.['项目组']) console.log(`    项目组=${firstRec['项目组']}`);
  }

  console.log('\n✅ 完成');
}

main().catch(e => { console.error('ERR:', e.message); process.exit(1); });
