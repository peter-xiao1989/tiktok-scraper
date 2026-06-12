# 多维表仪表盘(海外游戏发行)

> 数据底座 + 仪表盘都在多维表 YB8TbS「TT经营数据中心」,**已用 lark-cli 程序化建好**,
> 无需手动拖。本文档是结构说明 + 维护方法。

## 关键:图表能程序化建(之前判断有误)

飞书 **REST 开放 API** 确实不能建图表组件,但 **lark-cli 能**(`base +dashboard-*` /
`+dashboard-block-*`),支持 column/bar/line/pie/ring/area/scatter/funnel/radar/
statistics/text 各类型,带分组/聚合(SUM/AVERAGE/MAX/MIN)/排序/筛选。SSOT 文档:
`~/.agents/skills/lark-base/references/dashboard-block-data-config.md`。

## 数据底座(脚本自动同步,table_id 稳定)

| 多维表 | 内容 | 刷新 |
|---|---|---|
| **经营概览(每日)** | 总消耗/收入/当日ROI/累计ROI/环比/新增/消耗最高/**风险提示**/**经营概要** | 每次导入(build-overview.js) |
| **📊经营诊断与建议** | 6 条结构化诊断(整体盘/资源配置/主力/数据缺口…) | 手动更新 |
| 项目维度经营表 | 日×项目组:消耗/收入/累计ROI/新增 | 每次导入 |
| 各产品经营日报表 | 日×游戏:消耗/ROI/新增/活跃/启动成功率/eCPM… | 每次导入 |
| 投放日报-产品维度 / -素材维度 | 日×游戏/素材:消耗/ROAS/CTR/CPM… | 每次导入 |
| 分时素材效果表 | 当日分时素材级 | 每小时 |

> **sync-base.js 复用表(清记录重写),table_id 永久稳定 → 仪表盘图表不失效。**
> 早期删表重建导致图表掉数据源,已改成复用模式根治。表已去掉序号/类别列。

## 已建仪表盘

### 📊 经营总览(`blkN7iTRJwPqBFga`)⚠️ 用户手工维护
**bot 只能在末尾追加,严禁改/删/arrange 已有模块。**

### 🎬 素材分析(`blk8GaOBZTkjBLPx`)
方法论驱动重建版(2026-06-13):①资产盘点(评级卡+消耗分布)②分项目转化漏斗 ③吸量效率(IPM/EVR排行+散点)④回收质量(ROI/D6倍数/CPI)⑤疲劳监控(Top素材 CTR/CPM/ROI 走势)⑥新素材测试&机会榜。数据:素材分析/日趋势/漏斗 三表(build-material.js)。判定规则 docs/creative-analytics.md。

### ⏱ 投放实时监测(`blkuynWz9LEIZEwk`)
①实时大盘卡(消耗/较昨日/较7日均/ROI/🔴🟡预警数)②pacing三线+小时增量 ③项目实时 ④预警分布 ⑤素材出价实时。数据:track-hourly.js 每小时刷新(时录9天+7日均合成行/实时对比/实时预警)。

### 📱 APP经营总览(APP线 base `Fw8BbucPvaVdl8saebuc6FngnFg`, `blkoRaobobBEM6Bc`)
昨日/累计卡 + 近30天分资源趋势(新增/活跃/收入/留存/时长/ARPDAU)+ 占比环 + 国家Top条形。数据:src/apps/fetch-ga4.js 三表。

## 业务口径(看数前必懂,否则误判)

- **当日ROI**(收入/消耗):游戏发行**首日天然偏低**(0.3~0.8),靠后续 LTV,**不能拿它<1 当亏损**。
- **累计ROI**(累计收入/累计消耗):**真正的回本指标**,<1 未回本,看它能否随天数爬向 1.0+。
- 最新一天产品收入 **T+1 结算**(16点后):当天显示 0/待结算,非亏损。
- 起量初期小基数翻几倍是正常起量,非异常。
- 对比图的累计ROI 用 AVERAGE,边缘游戏(消耗≈0)可能 ROI 虚高,只看主力组。

## 维护:怎么改图

```bash
# 列仪表盘 / 看组件
lark-cli base +dashboard-list   --base-token <YB> --as bot
lark-cli base +dashboard-get    --base-token <YB> --dashboard-id <blk> --as bot
# 加图(data-config 见 SSOT 文档)
lark-cli base +dashboard-block-create --base-token <YB> --dashboard-id <blk> \
  --name "图名" --type column \
  --data-config '{"table_name":"项目维度经营表","series":[{"field_name":"消耗","rollup":"SUM"}],"group_by":[{"field_name":"项目组","mode":"integrated","sort":{"type":"value","order":"desc"}}]}' --as bot
# 改/删图 + 自动布局
lark-cli base +dashboard-block-update / +dashboard-block-delete ...
lark-cli base +dashboard-arrange --base-token <YB> --dashboard-id <blk> --as bot
```

> ⚠️ 若 sync-base 改回删表重建(table_id 变),图表会全部失效需重建——保持复用模式。

## 最该补的数据(命根子)

当前无**留存(次留/7留)、付费率、LTV曲线、回收周期**——这是判断"能否回本/何时回本"
的核心。补齐后可加:留存漏斗、LTV回收曲线、付费率对比,仪表盘价值再上台阶。
