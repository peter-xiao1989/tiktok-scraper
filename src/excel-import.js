const XLSX = require('xlsx');
const https = require('https');
const path = require('path');

const APP_TOKEN = 'HCXKb9qoDaiEmqsl4cocOnNPnpb';
const TABLE_ID  = 'tblIt96EqRXJQUR9'; // TT投放数据原表
const APP_ID     = process.env.FEISHU_APP_ID     || 'cli_aa898a664d395cc2';
const APP_SECRET = process.env.FEISHU_APP_SECRET || (() => { throw new Error('FEISHU_APP_SECRET env is required'); })();

function feishuReq(method, urlPath, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request({ hostname: 'open.feishu.cn', path: urlPath, method, headers },
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

async function getFields(token) {
  const r = await feishuReq('GET', `/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/fields`, token);
  return r.data.items || [];
}

async function addField(token, fieldName, fieldType) {
  const r = await feishuReq('POST', `/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/fields`, token,
    { field_name: fieldName, type: fieldType });
  if (r.code !== 0) console.warn(`  [warn] add field "${fieldName}": ${r.msg}`);
  else console.log(`  [field] created: ${fieldName}`);
}

function dateToTs(dateStr) {
  if (!dateStr || dateStr === '-') return null;
  return new Date(dateStr + 'T00:00:00Z').getTime();
}

function pctStr(v) {
  if (v == null || v === '-' || v === '') return '-';
  const n = parseFloat(v);
  if (isNaN(n)) return String(v);
  return (n * 100).toFixed(2) + '%';
}

function numOrNull(v) {
  if (v == null || v === '-' || v === '') return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

function rowToRecord(headers, row) {
  const get = name => row[headers.indexOf(name)];
  const fields = {};

  const textFields = ['系列名称', '账户名称', '广告名称', '创意素材名称', '广告 ID', '广告组名称'];
  for (const f of textFields) {
    const v = get(f);
    if (v != null && v !== '') fields[f] = String(v);
  }

  const numFields = ['消耗', '平均点击成本（目标页面）', '千次展示成本 (CPM)',
    '展示量', '点击量（目标页面）', '转化量', '覆盖千人成本', '覆盖人数', '频次', '平均转化成本'];
  for (const f of numFields) {
    const v = numOrNull(get(f));
    if (v !== null) fields[f] = v;
  }

  const ctr = get('点击率（目标页面）');
  fields['点击率（目标页面）'] = pctStr(ctr);

  const roas = numOrNull(get('广告收入 ROAS (TikTok)'));
  if (roas !== null) fields['广告收入 ROAS (TikTok)'] = roas;

  const ts = dateToTs(get('按天'));
  if (ts) fields['按天'] = ts;

  return fields;
}

async function batchCreate(token, records) {
  const BATCH = 500;
  let written = 0;
  for (let i = 0; i < records.length; i += BATCH) {
    const chunk = records.slice(i, i + BATCH);
    const r = await feishuReq('POST',
      `/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/records/batch_create`,
      token, { records: chunk.map(fields => ({ fields })) });
    if (r.code !== 0) throw new Error(`batch_create: ${JSON.stringify(r)}`);
    written += chunk.length;
    process.stdout.write(`\r  written ${written}/${records.length}...`);
  }
  process.stdout.write('\n');
}

// Returns set of date timestamps already present in Bitable
async function fetchExistingDates(token) {
  const dates = new Set();
  let pageToken = '';
  do {
    const qs = `page_size=500${pageToken ? '&page_token=' + pageToken : ''}`;
    const r = await feishuReq('GET',
      `/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/records?${qs}&fields=${encodeURIComponent('按天')}`, token);
    if (r.code !== 0) throw new Error(`fetchExisting: ${JSON.stringify(r)}`);
    for (const item of r.data.items || []) {
      const ts = item.fields['按天'];
      if (ts) dates.add(ts);
    }
    pageToken = r.data.has_more ? r.data.page_token : '';
  } while (pageToken);
  return dates;
}

async function main() {
  const xlsxFile = process.env.XLSX_FILE || '/Users/xiao/Downloads/TT所有产品消耗 (2).xlsx';
  const targetDate = process.env.TARGET_DATE || ''; // empty = all dates

  console.log(`Reading: ${xlsxFile}`);
  const wb = XLSX.readFile(xlsxFile);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
  const headers = rows[0];
  let dataRows = rows.slice(1).filter(r => r[5] && r[5] !== '-');

  if (targetDate) {
    dataRows = dataRows.filter(r => r[5] === targetDate);
    console.log(`Filtered to ${targetDate}: ${dataRows.length} rows`);
  } else {
    console.log(`All dates: ${dataRows.length} rows`);
  }

  if (dataRows.length === 0) { console.log('No data to import.'); return; }

  console.log('\nGetting Feishu token...');
  const token = await getTenantToken();

  console.log('Checking table fields...');
  const existingFields = await getFields(token);
  const existingNames = new Set(existingFields.map(f => f.field_name));
  if (!existingNames.has('广告收入 ROAS (TikTok)')) {
    console.log('Adding missing field: 广告收入 ROAS (TikTok)');
    await addField(token, '广告收入 ROAS (TikTok)', 2);
  }

  console.log('Building records...');
  const allRecords = dataRows.map(row => rowToRecord(headers, row)).filter(r => Object.keys(r).length > 0);
  console.log(`  ${allRecords.length} records built`);

  // Dedup by date: skip any date that already has data in Bitable
  console.log('Checking existing dates in Bitable...');
  const existingDates = await fetchExistingDates(token);
  const existingDateStrs = [...existingDates].map(ts => new Date(ts).toISOString().slice(0, 10)).sort();
  console.log(`  ${existingDates.size} dates already in table: ${existingDateStrs.join(', ') || 'none'}`);

  const newRecords = allRecords.filter(rec => !existingDates.has(rec['按天']));
  const skippedDates = [...new Set(allRecords.filter(rec => existingDates.has(rec['按天'])).map(rec => new Date(rec['按天']).toISOString().slice(0,10)))].sort();
  if (skippedDates.length) console.log(`  Skipping dates already present: ${skippedDates.join(', ')}`);
  console.log(`  ${newRecords.length} new records to write`);

  if (newRecords.length === 0) { console.log('Nothing to write.'); return; }

  console.log('Writing to Bitable...');
  await batchCreate(token, newRecords);

  console.log(`Done. ${newRecords.length} rows written.`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
