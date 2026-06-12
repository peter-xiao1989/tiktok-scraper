# APP 产品线(Google Play / App Store)数据管道

> 与 TikTok Minis 产品线**代码共仓、数据彻底分离**。本目录只放 APP 线脚本;
> 任何数据不得写入 TT经营数据中心/TT电子表格。

## 数据源规划

| 数据 | 来源 | 状态 |
|---|---|---|
| 行为(新增/活跃/留存/时长/事件) | Firebase → GA4 Data API(起步)/ BigQuery export(深度) | ⏳ 待服务账号 |
| 归因/买量(安装来源/媒体/Campaign) | AppsFlyer API(Pull API / Master API) | ⏳ 待 AF token |
| IAA 广告收入 | 聚合平台 API(AdMob / MAX,待确认哪家) | ⏳ 待确认 |
| IAP 内购 | Google Play Developer API / App Store Connect API | ⏳ 后续 |
| 投放消耗 | 投 TikTok 则复用现有 ads-api;Google/Meta 另接 | ⏳ 待确认渠道 |

## 接入前需要用户提供

1. **GA4**: Google Cloud 服务账号 JSON(加入 GA4 属性"查看者") + 两个 app 的 GA4 Property ID
2. **AppsFlyer**: API Token(V2.0,Dashboard→用户菜单→Security Center→API tokens)+ 两个 app 的 App ID(GP 包名 / iOS id)
3. 广告聚合平台名称与报表 API 凭证
4. 两个游戏的名称/项目组归属(用于命名)

## 目标结构(与 Minis 同构)

抓取脚本(本目录) → 独立飞书电子表格(APP原表) → 独立多维表「APP经营数据中心」
→ 经营日报/单产品 base/看板(复刻枪战模板)

## 命名约定

- workflow: `app-daily.yml`(独立,不混入现有)
- 飞书表/多维表: 前缀「APP-」或产品名
- 告警: `🔴 APP·…` 标签
- secrets: `GA4_SA_JSON` / `APPSFLYER_TOKEN` / `ADMOB_*`
