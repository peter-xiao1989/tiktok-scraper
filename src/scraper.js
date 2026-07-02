const { getClientKey, fetchAllGameData } = require('./api');

function msToMin(ms) {
  if (!ms) return 0;
  return parseFloat((ms / 60000).toFixed(2));
}

function msToSec(ms) {
  if (!ms) return 0;
  return parseFloat((ms / 1000).toFixed(2));
}

function pct(val) {
  if (val === null || val === undefined) return '';
  return (val * 100).toFixed(2) + '%';
}

function retVal(r, day) {
  const v = r[String(day)]?.[0]?.value;
  return v !== undefined ? pct(v) : '';
}

function usd(v) { return v !== undefined ? parseFloat(v.toFixed(4)) : ''; }
function num4(v) { return v !== undefined ? parseFloat(v.toFixed(4)) : ''; }

function mapRow(gameName, date, data, group = '') {
  const b = data.behavior.user_behavior_data || {};
  const p = data.performance.performance_data || {};
  const r = data.retention.retention_data || {};
  const i = data.iaa.iaa_data || {};
  const ao = data.adsOverview?.ads_overview_data || {};
  const fd = data.adsFirstDay?.first_day_activation_data || {};
  const ha = data.adsHistory?.history_activation_data || {};

  const activeUser = b.active_user?.value ?? 0;
  const adsExposure = i.ads_exposure?.value ?? 0;

  return {
    项目组: group,
    游戏名称: gameName,
    统计周期: date,
    // 用户行为
    新增用户: b.new_user?.value ?? '',
    活跃用户: activeUser,
    重复用户: b.repeat_user?.value ?? '',
    有效用户: b.effective_user?.value ?? '',
    总用户数: b.total_user?.value ?? '',
    总启动次数: b.play_session?.value ?? '',
    人均进入次数: b.avg_play_session?.value !== undefined ? parseFloat(b.avg_play_session.value.toFixed(3)) : '',
    每位用户平均时长_分: msToMin(b.duration_per_user?.value),
    次均游戏时长_分: msToMin(b.duration_per_session?.value),
    // 表现
    平均启动速度_秒: msToSec(p.avg_launch_speed?.value),
    平均首次启动速度_秒: msToSec(p.first_time_launch_speed?.value),
    启动成功率: p.launch_success_rate?.value !== undefined ? pct(p.launch_success_rate.value) : '',
    授权成功率: p.authorization_success_rate?.value !== undefined ? pct(p.authorization_success_rate.value) : '',
    // 留存
    次留: retVal(r, 1),
    七日留存: retVal(r, 7),
    十四日留存: retVal(r, 14),
    三十日留存: retVal(r, 30),
    // IAA变现
    广告请求量: i.ads_request?.value ?? '',
    广告曝光量: adsExposure,
    广告点击量: i.ads_click?.value ?? '',
    广告点击率: i.ads_click_rate?.value !== undefined ? pct(i.ads_click_rate.value) : '',
    eCPM: i.ecpm?.value !== undefined ? parseFloat(i.ecpm.value.toFixed(3)) : '',
    人均广告展示次数: activeUser > 0 ? parseFloat((adsExposure / activeUser).toFixed(3)) : 0,
    广告总收入: i.iaa_revenue?.value !== undefined ? parseFloat(i.iaa_revenue.value.toFixed(4)) : '',
    // 推荐页广告 - 概览
    推荐页_广告支出: usd(ao.ads_spend?.value),
    推荐页_已激活用户: ao.activated_users?.value ?? '',
    推荐页_付费流量收入: usd(ao.paid_traffic_revenue?.value),
    // 推荐页广告 - 首日激活
    推荐页_首日激活用户: fd.first_day_activated_users?.value ?? '',
    推荐页_首日ARPU: num4(fd.arpu?.value),
    推荐页_首日eCPM: num4(fd.ecpm?.value),
    推荐页_首日LTV: num4(fd.ltv?.value),
    推荐页_首日ROI: fd.roi?.value !== undefined ? pct(fd.roi.value) : '',
    推荐页_用户激活成本: num4(fd.user_activation_cost?.value),
    推荐页_首日付费收入: usd(fd.paid_traffic_revenue?.value),
    // 推荐页广告 - 历史激活
    推荐页_历史激活用户: ha.history_activated_users?.value ?? '',
    推荐页_历史eCPM: num4(ha.ecpm?.value),
    推荐页_历史付费收入: usd(ha.paid_traffic_revenue?.value),
  };
}

async function scrapeGame(game, date, portalCookies, dataCookies) {
  console.log(`  [${game.name}] fetching client_key...`);
  const clientKey = await getClientKey(game.id, portalCookies);

  console.log(`  [${game.name}] fetching data (key: ${clientKey})...`);
  const data = await fetchAllGameData(game.id, clientKey, date, dataCookies);

  return mapRow(game.name, date, data, game.group || '');
}

async function scrapeAll(games, date, portalCookies, dataCookies) {
  const rows = [];
  for (const game of games) {
    try {
      const row = await scrapeGame(game, date, portalCookies, dataCookies);
      rows.push({ ok: true, row });
      console.log(`  [${game.name}] OK`);
    } catch (err) {
      console.error(`  [${game.name}] ERROR: ${err.message}`);
      rows.push({ ok: false, game: game.name, error: err.message });
    }
  }
  return rows;
}

module.exports = { scrapeAll, mapRow };
