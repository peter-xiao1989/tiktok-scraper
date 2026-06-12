# APP 产品线(Google Play / App Store)数据管道

> 与 TikTok Minis 产品线**代码共仓、数据彻底分离**。本目录只放 APP 线脚本;
> 任何数据不得写入 TT经营数据中心/TT电子表格。

## 现状(已上线)

```
GA4 Data API(服务账号) ──fetch-ga4.js(app-daily.yml, 16:23 BJT)──▶ 多维表「APP经营数据中心」
```

- **多维表**: `Fw8BbucPvaVdl8saebuc6FngnFg`(APP经营数据中心)
- **三张表**(每次运行整表刷新 = 永久自愈,无增量缺口问题):
  - `APP-每日指标` — 全量历史(365d 窗口),资源×日:活跃/新增/会话/互动率/人均会话/时长/屏幕浏览/广告收入/总收入/ARPDAU/次留/7·14·30日留存
  - `APP-近30天` — 同字段近 30 天窗口,看板数据源(规避 datetime 筛选 API 不可用)
  - `APP-国家维度` — 近 30 天 资源×日×国家:活跃/新增/广告收入/总收入
- **留存口径**: GA4 cohort(firstSessionDate 分组,cohortActiveUsers/day0),只查有新增的日期
- **媒体资源**: 麻将-iOS 531751891 / 麻将-GP 539961183 / 积木-iOS 539468626 / 积木-GP 539517442
- **凭证**: 服务账号 `claudecode@mahjong-pair-deluxe.iam.gserviceaccount.com`,JSON 在 secret `GA4_SA_JSON`;须加入每个媒体资源的访问管理(查看者),新资源接入时别忘
- 运行失败 → 飞书 webhook 告警 `🔴 APP线·GA4 数据同步失败`

## 口径红线

GA4 活跃 = 有互动事件的用户;新增 = first_open;留存 = cohortActiveUsers。
**与 TikTok Portal(Minis 线)口径不同,严禁跨线直接对比。**

## 后续数据源规划

| 数据 | 来源 | 状态 |
|---|---|---|
| 归因/买量(安装来源/媒体/Campaign) | AppsFlyer API(Pull API / Master API) | ⏳ 待 AF token |
| IAA 广告收入(分平台/瀑布流) | 聚合平台 API(AdMob / MAX,待确认哪家) | ⏳ 待确认 |
| IAP 内购 | Google Play Developer API / App Store Connect API | ⏳ 后续 |
| 行为深度分析(事件级) | BigQuery export | ⏳ 需要时再开 |

AppsFlyer 接入需要:API Token(V2.0,Dashboard→用户菜单→Security Center→API tokens)+ App ID(GP 包名 / iOS id)。

## 命名约定

- workflow: `app-daily.yml`(独立,不混入 Minis 线)
- 飞书表/多维表: 前缀「APP-」或产品名
- 告警: `🔴 APP线·…` 标签
- secrets: `GA4_SA_JSON` / `APPSFLYER_TOKEN` / `ADMOB_*`
