# CLAUDE.md — tiktok-scraper

TikTok 投放/产品数据 → 飞书电子表格原表 → 衍生汇总表(node 静态值) → 多维表 YB8TbS/群报告。

## 数据流与定时

```
TikTok Marketing API ──ads-api(7:00 BJT)──┐
TikTok Developer Portal ─product-api(16:00)─┼─▶ 电子表格原表 ─▶ maintainAllDerived(node 算静态值) ─▶ sync-base.js 同步多维表
TikTok realtime ──realtime(每小时*)─────────┘
```

\* 准点触发由 `scheduler/`(Cloudflare worker, cron `0 * * * *`)负责:每小时触发分时,UTC 08:00(16点)加产品,23:00(7点)加投放;GitHub schedule 仅兜底(分时每2h);任一 workflow 失败→飞书机器人告警(secret `FEISHU_WEBHOOK`)。详见 `scheduler/README.md`。

| workflow | 触发 | 干什么 |
|---|---|---|
| daily-ads.yml | 07:00 BJT | 投放数据导入 + 重算衍生表 |
| daily-product.yml | 16:13/16:43 BJT | 产品数据导入 + 重算衍生表 |
| realtime.yml | 每小时(worker)/每2h(cron兜底) | 分时数据 + rebuild_*.py + `sync-base.js fenshi` + `track-hourly.js` 实时监测写多维表 |
| daily-reports.yml | 08:10 / 16:40 BJT | `sync-base.js` 同步多维表(群报告 if:false 暂停) |
| app-daily.yml | 16:23 BJT | APP线 GA4 → APP经营数据中心(与 Minis 线隔离) |

- **daily-ads 内置对账自愈**(src/audit-ads.js, AUTO_REPAIR=1):账户级 API 总量 vs 表内合计,显著差异(>$20 或 >15%)自动删残行→重拉→复核,修不回才告警;≤$20 且 ≤15% 是 ad级vs账户级固有口径差,只记日志**不要试图修**。根因:dedup 按账户|日期跳过,半天导入会被永久跳过——已由该机制根治。
- **daily-product 内置产品数据缺口检测**(src/audit-product.js):对比 juQobR 期望游戏 vs c50205 实际数据,近14天缺行/收入为0推飞书告警。`广告总收入`/新增/活跃/留存等产品指标来自 portal scraper(c50205),**不受 ads audit-repair 覆盖**;历史缺口需手动触发 daily-product workflow_dispatch 并填 `start_date`/`end_date` 补录。

## 必须知道的机制(违反会出错)

- **衍生表已静态值化(零公式)**。`maintainAllDerived`(src/maintain-derived.js)在 node 里读源表→聚合算值→写**纯静态值**(不再写公式)。这样源表删行/改数据不再触发飞书全表重算("一动就崩"已根治)。顺序固定:项目维度经营表最先(日报表排序键依赖它)。每张表写完用 `clearTrailingCols` 把旧 helper 公式列写空。
- **游戏配置权威源 = 电子表格「产品id及链接」(juQobR)**:A=项目组 B=产品名 C=id。无 id 的行跳过产品抓取。加新游戏只在这张表加行,不改代码。
- **衍生表按表头名定位列**(用户会改表头)。改报告列:动 FIELD_SRC/need() 的候选名,别按列号硬编码。匹配不到的列会被**静默跳过**——重跑后核对日志里每个 col 都 done。
- **静态值按列类型写**:消耗等小数列 round1;ROAS/ROI/率 等百分比列写小数(如 0.7)+ 0.00% 格式;日期列写 serial。源表数字是文本,node 用 `pnum`(剥 `,%`)/`ppct`(百分比文本 /100)解析。
- **ROAS 口径**:衍生表的 ROAS = Σ(投放原表消耗×ROAS)/Σ消耗(投放侧加权),**不是** 广告总收入/消耗。
- **ROI 业务口径(看数/告警必读)**:当日 ROI(收入/消耗)首日天然偏低靠 LTV;**累计 ROI 才是回本指标**;最新一天产品收入 T+1 结算(16点)前是"待结算"非亏损。详见 src/build-overview.js。
- 写值/记录量大时分块(≤200行/批)+ 限流重试(90217/90235/Data Not Ready 均为暂时性)。

## 红线

- **FEISHU_APP_SECRET 只能来自环境变量**,严禁回填明文到代码(历史上泄露过一次,已在轮换)。
- 衍生表(JIKPZV/6B1PVx/wAsSso/kX0M0R/TOBfe9 等)由 maintainAllDerived 算静态值、多维表由 sync-base.js 同步,**不要手工改**——下次刷新覆盖。

## 速查

- 电子表格(两个 token 等效,指同一张表):wiki node `J8mswO2vziyIAAkdt4rcVeaDnog`(node 代码 SPREADSHEET_TOKEN 用这个) / 原生 `K8tgsrOpFhxjy3tgDHscJ5jonHh`(python lark-cli 用这个)
- sheet id:投放原表 uqJEhq / 产品原表 c50205 / 分时原表 jArZTX / 日经营 wAsSso / 项目维度 JIKPZV / 各产品日报 6B1PVx / 投放日报-产品 kX0M0R / 投放日报-素材 TOBfe9 / 分时素材 dbGqhL / 产品id及链接 juQobR
- 多维表「TT经营数据中心」:`YB8TbS45kaO1gesMtqlc8kpznEb`。`src/sync-base.js [all|chanpin|toufang|fenshi]` 同步 6 张明细表(去序号/类别列、类型正确、**复用表清记录→table_id 稳定**);`src/build-overview.js` 建「经营概览(每日)」。**仪表盘(lark-cli 建)**:经营总览 `blkN7iTRJwPqBFga`(⚠️用户手工维护,bot只能末尾追加)/ 素材分析 `blk8GaOBZTkjBLPx`/ 实时监测 `blkuynWz9LEIZEwk`(track-hourly.js 每小时刷新)。改图用 `lark-cli base +dashboard-block-*`(REST API 建不了图表;`dashboard-block-delete` 要 `--yes`),详见 `docs/dashboard-guide.md`。字段格式用 base v3 `field-update`(number style.percentage/precision、datetime style.format="MM-dd";**飞书日期不支持中文格式**)。旧 base HCXKb… 弃用。
- **⚠️ sync-base 必须复用表(清记录),严禁删表重建**——table_id 一变,仪表盘所有图表失效需重建。
- `sheets_to_base.py` 已被 `src/sync-base.js` 取代(node 版可靠、能去序号、类型正确),保留备查。
- 游戏选品群:`oc_0d077d9ba6ce793a835b546bd9dbb9e6`
- 本地验证衍生表:`FEISHU_APP_SECRET=… node -e "…ensureReportFormulas/ensureDailySummary…"`(见 src/build-summaries.js exports)
- 外部准点调度:见 `scheduler/README.md`

## 两条产品线(严格隔离)

- **Minis 线**(现有): TikTok 小游戏,数据源 TikTok Marketing API/Developer Portal,落地 TT电子表格 + TT经营数据中心(YB8TbS)+ 单项目 base。
- **APP 线**(已上线): GP/AS 双端 app(麻将/积木),GA4 Data API → 多维表「APP经营数据中心」`Fw8BbucPvaVdl8saebuc6FngnFg`,代码在 `src/apps/`,workflow app-daily.yml。详见 `src/apps/README.md`(媒体资源ID/凭证/口径)。
- **红线**: 两线数据永不写入对方的表;表名/脚本/workflow/告警全部带线别前缀。口径差异(留存/收入定义 GA4≠TikTok Portal)在使用时必须标注,不做跨线直接对比。

## 素材分析与实时监测(方法论驱动,别拍脑袋改阈值)

`src/build-material.js`(生命周期评级)与 `src/track-hourly.js`(pacing三线+预警)的判定规则全部来自行业调研,依据与阈值见 **docs/creative-analytics.md** ——改阈值先读它;给用户解释评级口径也以它为准。素材表直接聚合投放原表(ad级),不再依赖 TOBfe9。
