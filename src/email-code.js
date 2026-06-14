/**
 * 从 163.com 邮箱读取 TikTok 验证码。
 * 依赖: imapflow (已在 package.json)
 * 必须环境变量: EMAIL_163_PASS (163.com IMAP 授权码，不是登录密码)
 * 可选: TIKTOK_EMAIL (默认 a3699251@163.com)
 */
const { ImapFlow } = require('imapflow');

const IMAP_HOST = 'imap.163.com';
const IMAP_PORT = 993;
const CODE_RE = /\b(\d{6})\b/;

async function tryFetch(user, pass) {
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user, pass },
    logger: false,
    tls: { rejectUnauthorized: false },
  });

  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const since = new Date(Date.now() - 8 * 60 * 1000); // last 8 minutes
      const uids = await client.search({ from: 'tiktok.com', since }, { uid: true });
      if (!uids || uids.length === 0) return null;

      const latest = [Math.max(...uids)];
      for await (const msg of client.fetch(latest, { envelope: true, bodyText: true }, { uid: true })) {
        const subject = msg.envelope?.subject || '';
        const body = msg.bodyText || '';
        const m = (subject + ' ' + body).match(CODE_RE);
        if (m) return m[1];
      }
      return null;
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

async function waitForTikTokCode(opts = {}) {
  const user = opts.user || process.env.TIKTOK_EMAIL || '';
  const pass = opts.pass || process.env.EMAIL_163_PASS;
  if (!pass) throw new Error('EMAIL_163_PASS not set — cannot read verification code automatically');

  const deadline = Date.now() + (opts.timeout || 120000);
  const interval = opts.pollInterval || 6000;

  console.log('[email-code] Waiting for TikTok verification email...');
  while (Date.now() < deadline) {
    const code = await tryFetch(user, pass).catch(e => {
      console.warn('[email-code] IMAP poll error:', e.message);
      return null;
    });
    if (code) {
      console.log('[email-code] Got code:', code);
      return code;
    }
    await new Promise(r => setTimeout(r, interval));
  }
  throw new Error('Timed out (2min) waiting for TikTok verification email');
}

module.exports = { waitForTikTokCode };
