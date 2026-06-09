const https = require('https');

const APP_TOKEN = process.env.FEISHU_BITABLE_TOKEN || 'HCXKb9qoDaiEmqsl4cocOnNPnpb';
const TABLE_ID  = process.env.FEISHU_BITABLE_TABLE  || 'tbl34DqzbdU9wqm1';

// field type: 1=text, 2=number
const FIELD_DEFS = [
  { name: '项目组',             type: 1 },
  { name: '游戏名称',           type: 1 },
  { name: '统计周期',           type: 5 },
  { name: '新增用户',           type: 2 },
  { name: '活跃用户',           type: 2 },
  { name: '重复用户',           type: 2 },
  { name: '有效用户',           type: 2 },
  { name: '总用户数',           type: 2 },
  { name: '总启动次数',         type: 2 },
  { name: '人均进入次数',       type: 2 },
  { name: '每位用户平均时长(分)', type: 2 },
  { name: '次均游戏时长(分)',   type: 2 },
  { name: '平均启动速度(秒)',   type: 2 },
  { name: '平均首次启动速度(秒)', type: 2 },
  { name: '启动成功率',         type: 1 },
  { name: '授权成功率',         type: 1 },
  { name: '次留',               type: 1 },
  { name: '7日留存',            type: 1 },
  { name: '14日留存',           type: 1 },
  { name: '30日留存',           type: 1 },
  { name: '广告请求量',         type: 2 },
  { name: '广告曝光量',         type: 2 },
  { name: '广告点击量',         type: 2 },
  { name: '广告点击率',         type: 1 },
  { name: 'eCPM',               type: 2 },
  { name: '人均广告展示次数',   type: 2 },
  { name: '广告总收入',         type: 2 },
  { name: '推荐页_广告支出',    type: 2 },
  { name: '推荐页_已激活用户',  type: 2 },
  { name: '推荐页_付费流量收入', type: 2 },
  { name: '推荐页_首日激活用户', type: 2 },
  { name: '推荐页_首日ARPU',    type: 2 },
  { name: '推荐页_首日eCPM',    type: 2 },
  { name: '推荐页_首日LTV',     type: 2 },
  { name: '推荐页_首日ROI',     type: 1 },
  { name: '推荐页_用户激活成本', type: 2 },
  { name: '推荐页_首日付费收入', type: 2 },
  { name: '推荐页_历史激活用户', type: 2 },
  { name: '推荐页_历史eCPM',    type: 2 },
  { name: '推荐页_历史付费收入', type: 2 },
];

// Keys match scraper row object keys
const FIELD_KEYS = [
  '项目组', '游戏名称', '统计周期',
  '新增用户', '活跃用户', '重复用户', '有效用户', '总用户数',
  '总启动次数', '人均进入次数', '每位用户平均时长_分', '次均游戏时长_分',
  '平均启动速度_秒', '平均首次启动速度_秒', '启动成功率', '授权成功率',
  '次留', '七日留存', '十四日留存', '三十日留存',
  '广告请求量', '广告曝光量', '广告点击量', '广告点击率', 'eCPM', '人均广告展示次数', '广告总收入',
  '推荐页_广告支出', '推荐页_已激活用户', '推荐页_付费流量收入',
  '推荐页_首日激活用户', '推荐页_首日ARPU', '推荐页_首日eCPM', '推荐页_首日LTV',
  '推荐页_首日ROI', '推荐页_用户激活成本', '推荐页_首日付费收入',
  '推荐页_历史激活用户', '推荐页_历史eCPM', '推荐页_历史付费收入',
];

function request(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request({ hostname: 'open.feishu.cn', path, method, headers }, res => {
      let buf = ''; res.on('data', c => buf += c);
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve(buf); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function getTenantToken(appId, appSecret) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ app_id: appId, app_secret: appSecret });
    const req = https.request({
      hostname: 'open.feishu.cn',
      path: '/open-apis/auth/v3/tenant_access_token/internal',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      let buf = ''; res.on('data', c => buf += c);
      res.on('end', () => {
        const parsed = JSON.parse(buf);
        if (parsed.code !== 0) reject(new Error('Feishu auth: ' + parsed.msg));
        else resolve(parsed.tenant_access_token);
      });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

async function getExistingFields(token) {
  const res = await request('GET',
    `/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/fields?page_size=100`,
    token
  );
  return (res.data?.items || []).map(f => ({ id: f.field_id, name: f.field_name, type: f.type }));
}

async function setupFields(token) {
  const existing = await getExistingFields(token);
  const existingNames = new Set(existing.map(f => f.name));

  // Rename default "文本" field to first field name if needed
  const firstField = FIELD_DEFS[0];
  const defaultField = existing.find(f => f.name === '文本');
  if (defaultField && !existingNames.has(firstField.name)) {
    await request('PUT',
      `/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/fields/${defaultField.id}`,
      token,
      { field_name: firstField.name, type: firstField.type }
    );
    existingNames.delete('文本');
    existingNames.add(firstField.name);
  }

  // Create missing fields in order
  for (const def of FIELD_DEFS) {
    if (!existingNames.has(def.name)) {
      const res = await request('POST',
        `/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/fields`,
        token,
        { field_name: def.name, type: def.type }
      );
      if (res.code !== 0) {
        console.error(`  Failed to create field "${def.name}":`, res.msg || JSON.stringify(res));
      }
    }
  }
  console.log('Fields setup complete.');
}

function rowToRecord(row) {
  const fields = {};
  FIELD_DEFS.forEach((def, i) => {
    let val = row[FIELD_KEYS[i]];
    if (val === undefined || val === '') return;
    if (def.type === 5 && typeof val === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(val)) {
      val = new Date(val).getTime();
    }
    fields[def.name] = val;
  });
  return { fields };
}

async function appendRecords(rows, { appId, appSecret }) {
  const token = await getTenantToken(appId, appSecret);
  const records = rows.map(rowToRecord);

  // Bitable allows max 500 records per batch
  const BATCH = 500;
  for (let i = 0; i < records.length; i += BATCH) {
    const batch = records.slice(i, i + BATCH);
    const res = await request('POST',
      `/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/records/batch_create`,
      token,
      { records: batch }
    );
    if (res.code !== 0) throw new Error('Bitable write failed: ' + (res.msg || JSON.stringify(res)));
  }
}

async function initBitable({ appId, appSecret }) {
  const token = await getTenantToken(appId, appSecret);
  await setupFields(token);
}

module.exports = { initBitable, appendRecords };
