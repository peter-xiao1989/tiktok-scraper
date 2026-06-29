/**
 * 产品数据采集 → D1（隔离飞书）
 *
 * 从 D1 games 取名录(minis_id) → 抓 TikTok 开发者后台 → 直写 D1 products_raw。
 * 不读 juQobR、不写 c50205，完全脱离飞书。登录态用 data/auth-state.json 缓存 cookie。
 *
 * 用法: DATES=2026-06-22,2026-06-23,2026-06-24 node src/product-to-d1.js
 *       不传 DATES 时默认回看最近 3 天(北京时区)。
 */
const fs = require('path').join ? require('fs') : require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { getCookieHeader } = require('./auth');
const { getClientKey, fetchAllGameData } = require('./api');
const { mapRow } = require('./scraper');

const DB = 'tiktok-analytics';
const ANALYTICS_DIR = path.join(process.env.HOME, 'tiktok-analytics');

function wrangler(args) {
  return execFileSync('npx', ['wrangler', ...args], { cwd: ANALYTICS_DIR, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}
function d1Query(sql) {
  const out = wrangler(['d1', 'execute', DB, '--remote', '--json', '--command', sql]);
  return JSON.parse(out)[0].results;
}
function d1File(sql) {
  const f = path.join(require('os').tmpdir(), `p2d1_${process.pid}.sql`);
  fs.writeFileSync(f, sql);
  wrangler(['d1', 'execute', DB, '--remote', `--file=${f}`]);
  fs.unlinkSync(f);
}

const serial = ds => { const [y, m, d] = ds.split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / 86400000) + 25569; };
const num = v => (v === undefined || v === null ? 0 : Number(v)) || 0;
const ret = (r, day) => num(r?.[String(day)]?.[0]?.value);
const sq = s => `'${String(s).replace(/'/g, "''")}'`;

function extract(gameName, group, date, data) {
  const b = data.behavior?.user_behavior_data || {};
  const i = data.iaa?.iaa_data || {};
  const r = data.retention?.retention_data || {};
  return {
    stat_date: date, stat_serial: serial(date), group_name: group, game: gameName,
    new_users: num(b.new_user?.value),
    active_users: num(b.active_user?.value),
    ad_revenue: num(i.iaa_revenue?.value),
    ret_d1: ret(r, 1), ret_d7: ret(r, 7), ret_d14: ret(r, 14), ret_d30: ret(r, 30),
    ecpm: num(i.ecpm?.value),
    ad_impressions: num(i.ads_exposure?.value),
    // 开发者后台全字段(中文键,对齐多维表列名)→ 供38列明细表从 D1 还原,一列不丢
    portal_json: JSON.stringify(mapRow(gameName, date, data, group)),
  };
}

function defaultDates() {
  const bj = new Date(Date.now() + 8 * 3600000);
  const out = [];
  for (let k = 1; k <= 3; k++) { const d = new Date(bj); d.setUTCDate(d.getUTCDate() - k); out.push(d.toISOString().slice(0, 10)); }
  return out.reverse();
}

async function fetchRoster() {
  // CI:从 /api/export/roster 取名录(免 wrangler);本地:d1Query
  if (process.env.ANALYTICS_URL && process.env.EXPORT_TOKEN) {
    const https = require('https');
    const u = new URL(process.env.ANALYTICS_URL.replace(/\/$/, '') + '/api/export/roster?token=' + encodeURIComponent(process.env.EXPORT_TOKEN));
    const data = await new Promise((res, rej) => { https.get(u, rs => { let c = ''; rs.on('data', d => c += d); rs.on('end', () => { try { res(JSON.parse(c)); } catch (e) { rej(e); } }); }).on('error', rej); });
    return (data.games || data.rows || data).filter(g => g.minis_id).map(g => ({ game: g.game, group_name: g.group_name || g.group, minis_id: g.minis_id }));
  }
  return d1Query(`SELECT game, group_name, minis_id FROM games WHERE minis_id IS NOT NULL AND minis_id!='' ORDER BY group_name, game`);
}

async function main() {
  const dates = (process.env.DATES || '').split(',').map(s => s.trim()).filter(Boolean);
  const targetDates = dates.length ? dates : defaultDates();
  const roster = await fetchRoster();
  console.log(`名录 ${roster.length} 个游戏(有 minis_id),日期 ${targetDates.join(',')}`);

  const state = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/auth-state.json'), 'utf8'));
  const portal = getCookieHeader(state, 'developers.tiktok.com');
  const dataCk = getCookieHeader(state, 'developers.us.tiktok.com') || portal;

  const rows = [];
  let ok = 0, fail = 0;
  for (const g of roster) {
    let ck;
    try { ck = await getClientKey(g.minis_id, portal); }
    catch (e) { console.error(`  [${g.game}] client_key 失败: ${e.message}`); fail++; continue; }
    for (const date of targetDates) {
      try {
        const data = await fetchAllGameData(g.minis_id, ck, date, dataCk);
        rows.push(extract(g.game, g.group_name, date, data));
        ok++;
      } catch (e) { console.error(`  [${g.game} ${date}] ${e.message}`); fail++; }
    }
    console.log(`  [${g.game}] done`);
  }

  if (!rows.length) { console.log('无数据,退出'); return; }
  // CI/远程:有 ANALYTICS_URL+EXPORT_TOKEN 则 POST 到 /api/ingest/products(免 wrangler 凭证);否则本地走 wrangler
  if (process.env.ANALYTICS_URL && process.env.EXPORT_TOKEN) {
    const https = require('https');
    const url = process.env.ANALYTICS_URL.replace(/\/$/, '');
    for (let i = 0; i < rows.length; i += 40) {
      const body = JSON.stringify({ rows: rows.slice(i, i + 40) });
      await new Promise((res, rej) => {
        const u = new URL(url + '/api/ingest/products?token=' + encodeURIComponent(process.env.EXPORT_TOKEN));
        const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, rs => { let c = ''; rs.on('data', d => c += d); rs.on('end', () => { try { JSON.parse(c).ok ? res() : rej(new Error(c.slice(0, 150))); } catch { rej(new Error(c.slice(0, 150))); } }); });
        req.on('error', rej); req.write(body); req.end();
      });
      console.log(`  POST ${Math.min(i + 40, rows.length)}/${rows.length}`);
    }
    console.log(`✅ POST products_raw ${rows.length} 行(成功 ${ok},失败 ${fail})`);
    return;
  }
  const values = rows.map(r =>
    `(${sq(r.stat_date)},${r.stat_serial},${sq(r.group_name)},${sq(r.game)},${r.new_users},${r.active_users},${r.ad_revenue},${r.ret_d1},${r.ret_d7},${r.ret_d14},${r.ret_d30},${r.ecpm},${r.ad_impressions},${sq(r.portal_json)},datetime('now'))`
  );
  // 分块写(portal_json 较大,单块 40 行控制 SQL 体积)
  for (let i = 0; i < values.length; i += 40) {
    const chunk = values.slice(i, i + 40);
    const sql = `INSERT INTO products_raw (stat_date,stat_serial,group_name,game,new_users,active_users,ad_revenue,ret_d1,ret_d7,ret_d14,ret_d30,ecpm,ad_impressions,portal_json,updated_at) VALUES\n${chunk.join(',\n')}\nON CONFLICT(game,stat_date) DO UPDATE SET group_name=excluded.group_name,new_users=excluded.new_users,active_users=excluded.active_users,ad_revenue=excluded.ad_revenue,ret_d1=excluded.ret_d1,ret_d7=excluded.ret_d7,ret_d14=excluded.ret_d14,ret_d30=excluded.ret_d30,ecpm=excluded.ecpm,ad_impressions=excluded.ad_impressions,portal_json=excluded.portal_json,updated_at=datetime('now');`;
    d1File(sql);
  }
  console.log(`✅ 写入 products_raw ${rows.length} 行(成功抓取 ${ok},失败 ${fail})`);
}

main().catch(e => { console.error('ERR', e.message); process.exit(1); });
