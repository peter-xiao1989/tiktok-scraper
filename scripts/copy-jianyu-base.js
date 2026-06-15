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
// 从 batch_query meta 里得到的用户 open_id
const USER_OPEN_ID = 'ou_d7ea3ebd5966b4a30661d52f53e72894';

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

  // 0. 获取 bot 根目录（用于复制目标）
  const rootMeta = await req('GET', '/open-apis/drive/explorer/v2/root_folder/meta', token);
  const folderToken = rootMeta.data?.token;
  if (!folderToken) { console.error('Cannot get root folder:', JSON.stringify(rootMeta)); process.exit(1); }
  console.log('Root folder token:', folderToken);

  // 1. 复制枪战 base
  console.log('Copying 枪战 base...');
  const copy = await req('POST', `/open-apis/drive/v1/files/${QIANGZHAN_BASE}/copy`, token, {
    name: '监狱经营数据中心',
    type: 'bitable',
    folder_token: folderToken,
  });

  if (copy.code !== 0) {
    console.error('Copy failed:', JSON.stringify(copy, null, 2));
    process.exit(1);
  }

  const newToken = copy.data?.file?.token;
  console.log(`New base token: ${newToken}`);

  // 2. 把用户加为管理员（用 open_id）
  const perm = await req('POST', `/open-apis/drive/v1/permissions/${newToken}/members?type=bitable&need_notification=false`, token, {
    member_type: 'openid',
    member_id: USER_OPEN_ID,
    perm: 'full_access',
  });
  console.log('Add owner:', perm.code === 0 ? '✅ 用户已加为管理员' : JSON.stringify(perm));

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
