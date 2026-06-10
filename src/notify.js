const https = require('https');

// Post a text message to the Feishu custom-bot webhook (FEISHU_WEBHOOK env).
// No-op if the env isn't set. Best-effort — never throws.
function notifyFeishu(text) {
  const url = process.env.FEISHU_WEBHOOK;
  if (!url) return Promise.resolve();
  return new Promise(resolve => {
    try {
      const u = new URL(url);
      const body = JSON.stringify({ msg_type: 'text', content: { text } });
      const req = https.request(
        { hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
        res => { res.on('data', () => {}); res.on('end', resolve); });
      req.on('error', () => resolve());
      req.write(body); req.end();
    } catch { resolve(); }
  });
}

// Beijing "MM-DD HH:mm"
function bjtStamp() {
  return new Date(Date.now() + 8 * 3600000).toISOString().replace('T', ' ').slice(5, 16);
}

module.exports = { notifyFeishu, bjtStamp };
