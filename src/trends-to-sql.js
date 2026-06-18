// 把 /tmp/trends.json 转成 INSERT OR REPLACE SQL（本地灌库用，绕过 ingest 端点/密钥）。
const fs = require('fs');
const IN = process.env.TRENDS_OUT || '/tmp/trends.json';
const all = JSON.parse(fs.readFileSync(IN, 'utf8'));
const q = v => v == null ? 'NULL' : (typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const lines = [];
for (const p of all) {
  for (const it of p.items) {
    const id = `${p.type}:${p.region}:${p.period}:${p.snap_date}:${it.ext_id}`;
    lines.push(`INSERT OR REPLACE INTO trends (id,type,region,period,snap_date,rank,ext_id,title,brand,industry,ctr,likes,cost,duration,width,height,cover_url,video_url,landing) VALUES (${[
      id, p.type, p.region, p.period, p.snap_date, it.rank, it.ext_id, it.title, it.brand, it.industry,
      it.ctr, it.likes, it.cost, it.duration, it.width, it.height, it.cover_url, it.video_url, it.landing,
    ].map(q).join(',')});`);
  }
}
fs.writeFileSync('/tmp/trends.sql', lines.join('\n'));
console.log(`${lines.length} 行 → /tmp/trends.sql`);
