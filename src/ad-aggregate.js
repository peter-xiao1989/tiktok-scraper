const https = require('https');

const APP_TOKEN = 'HCXKb9qoDaiEmqsl4cocOnNPnpb';
const SOURCE_TABLE = 'tblIT7JYJAv5pKYm';
const APP_ID = process.env.FEISHU_APP_ID || 'cli_aa898a664d395cc2';
const APP_SECRET = process.env.FEISHU_APP_SECRET || 'fOlixcmQNWlOBkrEAHagGdZUI5Fum3KX';

function feishuReq(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request({ hostname: 'open.feishu.cn', path, method, headers },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d))); });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function getTenantToken() {
  const r = await feishuReq('POST', '/open-apis/auth/v3/tenant_access_token/internal', '',
    { app_id: APP_ID, app_secret: APP_SECRET });
  return r.tenant_access_token;
}

async function getAllRecords(token, tableId) {
  const records = [];
  let pageToken = '';
  do {
    const qs = `page_size=500${pageToken ? '&page_token=' + pageToken : ''}`;
    const r = await feishuReq('GET', `/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records?${qs}`, token);
    if (r.code !== 0) throw new Error(`fetchRecords error: ${JSON.stringify(r)}`);
    records.push(...(r.data.items || []));
    pageToken = r.data.has_more ? r.data.page_token : '';
    process.stdout.write(`\r  fetched ${records.length}...`);
  } while (pageToken);
  process.stdout.write('\n');
  return records;
}

function parseNum(v) {
  if (v == null || v === '-' || v === '') return 0;
  const n = parseFloat(String(v).replace(/,/g, ''));
  return isNaN(n) ? 0 : n;
}

function getGameName(v) {
  if (!v) return '';
  if (Array.isArray(v)) return v.map(x => x.text || '').join('');
  return String(v);
}

function tsToDate(ms) {
  if (!ms) return '';
  return new Date(ms).toISOString().slice(0, 10);
}

function aggregate(records) {
  const map = new Map();
  for (const rec of records) {
    const f = rec.fields;
    const game = getGameName(f['游戏名称']);
    const date = tsToDate(f['按天']);
    if (!game || !date) continue;
    const key = `${game}__${date}`;
    if (!map.has(key)) {
      map.set(key, { game, date, spend: 0, impressions: 0, clicks: 0, conversions: 0, reach: 0 });
    }
    const row = map.get(key);
    row.spend       += parseNum(f['消耗']);
    row.impressions += parseNum(f['展示量']);
    row.clicks      += parseNum(f['点击量（目标页面）']);
    row.conversions += parseNum(f['转化量']);
    row.reach       += parseNum(f['覆盖人数']);
  }

  return Array.from(map.values()).map(r => {
    const cpm        = r.impressions > 0 ? (r.spend / r.impressions * 1000) : 0;
    const cpc        = r.clicks > 0 ? (r.spend / r.clicks) : 0;
    const ctr        = r.impressions > 0 ? (r.clicks / r.impressions * 100) : 0;
    const cpa        = r.conversions > 0 ? (r.spend / r.conversions) : 0;
    const cpr        = r.reach > 0 ? (r.spend / r.reach * 1000) : 0;
    const frequency  = r.reach > 0 ? (r.impressions / r.reach) : 0;
    return {
      '游戏名称':             r.game,
      '日期':                 r.date,
      '消耗':                 parseFloat(r.spend.toFixed(2)),
      '展示量':               r.impressions,
      '点击量':               r.clicks,
      '点击率':               parseFloat(ctr.toFixed(4)),
      'CPM（千次展示成本）':   parseFloat(cpm.toFixed(2)),
      '平均点击成本':          parseFloat(cpc.toFixed(2)),
      '转化量':               r.conversions,
      '平均转化成本':          parseFloat(cpa.toFixed(2)),
      '覆盖人数':             r.reach,
      '覆盖千人成本':          parseFloat(cpr.toFixed(2)),
      '频次':                 parseFloat(frequency.toFixed(2)),
    };
  }).sort((a, b) => a['游戏名称'].localeCompare(b['游戏名称']) || a['日期'].localeCompare(b['日期']));
}

const DEST_FIELDS = [
  { field_name: '游戏名称',           type: 1 },
  { field_name: '日期',               type: 1 },
  { field_name: '消耗',               type: 2 },
  { field_name: '展示量',             type: 2 },
  { field_name: '点击量',             type: 2 },
  { field_name: '点击率',             type: 2 },
  { field_name: 'CPM（千次展示成本）', type: 2 },
  { field_name: '平均点击成本',        type: 2 },
  { field_name: '转化量',             type: 2 },
  { field_name: '平均转化成本',        type: 2 },
  { field_name: '覆盖人数',           type: 2 },
  { field_name: '覆盖千人成本',        type: 2 },
  { field_name: '频次',               type: 2 },
];

async function getOrCreateDestTable(token) {
  const r = await feishuReq('GET', `/open-apis/bitable/v1/apps/${APP_TOKEN}/tables`, token);
  const existing = r.data.items.find(t => t.name === 'TT投放数据汇总');
  if (existing) return existing.table_id;

  // Try to create; if permission denied, prompt user to create manually
  const created = await feishuReq('POST', `/open-apis/bitable/v1/apps/${APP_TOKEN}/tables`, token, {
    table: { name: 'TT投放数据汇总', fields: DEST_FIELDS }
  });
  if (created.code !== 0) {
    throw new Error(
      `无法自动建表（权限不足）。\n请在飞书多维表格里手动新建一张表，命名为「TT投放数据汇总」，然后重新运行脚本。\n原始错误: ${JSON.stringify(created)}`
    );
  }
  return created.data.table_id;
}

async function ensureFields(token, tableId) {
  const r = await feishuReq('GET', `/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/fields`, token);
  const existing = new Set((r.data.items || []).map(f => f.field_name));

  // Rename primary field if it's still the default
  const primary = r.data.items?.[0];
  if (primary && primary.field_name === '文本') {
    await feishuReq('PUT', `/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/fields/${primary.field_id}`, token,
      { field_name: '游戏名称', type: 1 });
    existing.delete('文本');
    existing.add('游戏名称');
  }

  for (const fd of DEST_FIELDS) {
    if (!existing.has(fd.field_name)) {
      await feishuReq('POST', `/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/fields`, token, fd);
    }
  }
}

async function clearRecords(token, tableId) {
  let deleted = 0;
  while (true) {
    const r = await feishuReq('GET', `/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records?page_size=500`, token);
    const ids = (r.data.items || []).map(x => x.record_id);
    if (ids.length === 0) break;
    await feishuReq('DELETE', `/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records/batch_delete`, token,
      { records: ids });
    deleted += ids.length;
    process.stdout.write(`\r  cleared ${deleted}...`);
  }
  if (deleted > 0) process.stdout.write('\n');
}

async function writeRecords(token, tableId, rows) {
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const r = await feishuReq('POST', `/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records/batch_create`, token, {
      records: chunk.map(row => ({ fields: row }))
    });
    if (r.code !== 0) throw new Error(`batch_create error: ${JSON.stringify(r)}`);
    process.stdout.write(`\r  written ${Math.min(i + BATCH, rows.length)}/${rows.length}...`);
  }
  process.stdout.write('\n');
}

async function main() {
  console.log('Getting token...');
  const token = await getTenantToken();

  console.log('Reading source records...');
  const records = await getAllRecords(token, SOURCE_TABLE);
  console.log(`  total: ${records.length} rows`);

  console.log('Aggregating...');
  const rows = aggregate(records);
  console.log(`  result: ${rows.length} rows (${new Set(rows.map(r => r['游戏名称'])).size} games)`);

  console.log('Setting up destination table...');
  const destTableId = await getOrCreateDestTable(token);
  await ensureFields(token, destTableId);

  console.log('Clearing old data...');
  await clearRecords(token, destTableId);

  console.log('Writing aggregated data...');
  await writeRecords(token, destTableId, rows);

  console.log(`Done. ${rows.length} rows written to TT投放数据汇总.`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
