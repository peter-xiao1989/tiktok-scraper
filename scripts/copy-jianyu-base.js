/**
 * 复制枪战 base → 监狱经营数据中心
 * 1. 找到用户自己 base 的父文件夹（这样复制出的 base 在用户空间里，用户有权限）
 * 2. 把枪战 base 复制进那个文件夹（含仪表盘）
 * 3. 把表名 枪战-* 改成 监狱-*
 * 4. 输出新 base token，更新 JIANYU_BASE secret 后重跑 daily-reports 填数据
 */
const https = require('https');
const { getFeishuToken } = require('../src/build-summaries');

const QIANGZHAN_BASE = 'X89dbn5DZaYhMqsjcE1cZv3snD4';
// 用户自己有权限的 base，用来找目标文件夹
const USER_BASE = process.env.JIANYU_BASE || 'VfIVbeCdSaqJ2xspWXtcNtGNnFg';

function req(m, p, t, b) {
  return new Promise((res, rej) => {
    const d = b ? JSON.stringify(b) : null;
    const h = { 'Content-Type': 'application/json' };
    if (t) h.Authorization = 'Bearer ' + t;
    if (d) h['Content-Length'] = Buffer.byteLength(d);
    const r = https.request({ hostname: 'open.feishu.cn', path: p, method: m, headers: h, timeout: 30000 }, rs => {
      const c = []; rs.on('data', x => c.push(x));
      rs.on('end', () => { try { res(JSON.parse(Buffer.concat(c).toString())); } catch { res({}); } });
    });
    r.on('timeout', () => { r.destroy(); rej(new Error('timeout')); });
    r.on('error', rej);
    if (d) r.write(d);
    r.end();
  });
}

async function main() {
  const token = await getFeishuToken();

  // 0. 查用户 base 的父文件夹
  console.log('Getting parent folder of user base...');
  const meta = await req('POST', '/open-apis/drive/v1/metas/batch_query', token, {
    request_docs: [{ doc_token: USER_BASE, doc_type: 'bitable' }],
    with_url: false,
  });
  const parentToken = meta.data?.metas?.[0]?.parent_token;
  console.log('Meta result:', JSON.stringify(meta.data?.metas?.[0]));
  if (!parentToken) {
    console.error('Cannot get parent folder. Full response:', JSON.stringify(meta));
    process.exit(1);
  }
  console.log('Parent folder token:', parentToken);

  // 1. 复制枪战 base 进用户文件夹
  console.log('Copying 枪战 base into user folder...');
  const copy = await req('POST', `/open-apis/drive/v1/files/${QIANGZHAN_BASE}/copy`, token, {
    name: '监狱经营数据中心',
    type: 'bitable',
    folder_token: parentToken,
  });

  if (copy.code !== 0) {
    console.error('Copy failed:', JSON.stringify(copy, null, 2));
    process.exit(1);
  }

  const newToken = copy.data?.file?.token;
  console.log(`New base token: ${newToken}`);

  // 等待 Feishu 处理
  await new Promise(r => setTimeout(r, 6000));

  // 2. 列出新 base 的所有表
  const tbls = await req('GET', `/open-apis/bitable/v1/apps/${newToken}/tables?page_size=100`, token);
  const tables = tbls.data?.items || [];
  console.log('Tables:', tables.map(t => t.name).join(', '));

  // 3. 把 枪战-* 改成 监狱-*
  for (const t of tables) {
    if (t.name.startsWith('枪战-')) {
      const newName = t.name.replace('枪战-', '监狱-');
      const r = await req('PATCH', `/open-apis/bitable/v1/apps/${newToken}/tables/${t.table_id}`, token, { name: newName });
      console.log(`  ${t.name} → ${newName}:`, r.code === 0 ? 'OK' : JSON.stringify(r));
    }
  }

  console.log(`\n✅ 完成！`);
  console.log(`请设置 GitHub Secret: JIANYU_BASE = ${newToken}`);
}

main().catch(e => { console.error('ERR:', e.message); process.exit(1); });
