const https = require('https');
const { getFeishuToken } = require('../src/build-summaries');

const BASE = 'I9arbAocBaZIpBscT0Gc8sAYn2d';
const USER_EMAIL = 'xiaohuipeng123@gmail.com';

function req(m, p, t, b) {
  return new Promise((res, rej) => {
    const d = b ? JSON.stringify(b) : null;
    const h = { 'Content-Type': 'application/json' };
    if (t) h.Authorization = 'Bearer ' + t;
    if (d) h['Content-Length'] = Buffer.byteLength(d);
    const r = https.request({ hostname: 'open.feishu.cn', path: p, method: m, headers: h, timeout: 15000 }, rs => {
      const c = []; rs.on('data', x => c.push(x));
      rs.on('end', () => { try { res(JSON.parse(Buffer.concat(c).toString())); } catch { res({}); } });
    });
    r.on('timeout', () => { r.destroy(); rej(new Error('timeout')); });
    r.on('error', rej); if (d) r.write(d); r.end();
  });
}

async function main() {
  const token = await getFeishuToken();

  // 1. 设为获得链接的人均可阅读
  const pub = await req('PUT', `/open-apis/drive/v1/permissions/${BASE}/public?type=bitable`, token, {
    external_access_entity: 'open',
    security_entity: 'anyone_can_view',
    comment_entity: 'no_one_can_comment',
    link_share_entity: 'anyone_readable',
    invite_external: true,
  });
  console.log('Public link:', pub.code === 0 ? '✅ 任何人可阅读' : JSON.stringify(pub));

  // 2. email → union_id
  const uid = await req('POST', '/open-apis/contact/v3/users/batch_get_id?user_id_type=union_id', token, { emails: [USER_EMAIL] });
  const unionId = uid.data?.email_users?.[USER_EMAIL]?.[0]?.user_id;
  if (!unionId) { console.error('Cannot find union_id for', USER_EMAIL, JSON.stringify(uid)); process.exit(1); }
  console.log('union_id:', unionId);

  // 3. 加用户为管理员
  const mem = await req('POST', `/open-apis/drive/v1/permissions/${BASE}/members?type=bitable&need_notification=false`, token, {
    member_type: 'union_id',
    member_id: unionId,
    perm: 'full_access',
  });
  console.log('Add admin:', mem.code === 0 ? `✅ ${USER_EMAIL} 已设为管理员` : JSON.stringify(mem));
}

main().catch(e => { console.error('ERR:', e.message); process.exit(1); });
