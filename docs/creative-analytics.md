# 素材分析与实时监控方法论(2026-06 调研落地版)

> build-material.js(素材生命周期评级)与 track-hourly.js(实时预警)的设计依据。
> 调研来源:Gamigion / Admiral Media / Triple Whale / Segwise / Motion / AppsFlyer / Sprinklr 等,链接见文末。

## 素材漏斗(全指标可从投放原表算)

```
曝光(imp, CPM) → 6s互动观看(EVR=engaged_view/imp, hook proxy) → 点击(CTR, CPC)
→ 安装(CVR=inst/clk, IPM=inst/imp×1000, CPI) → 游戏新增(首启率=新增/安装) → 回收(首日ROI, D6/D0倍数)
```

- **吸量**看 EVR / CTR / IPM(早期最强预测器);**质量**看 CVR / CPI / 首启率(高CTR+低CVR=标题党);
  **回收**看首日ROI(卡 scaling 关)与 D6/D0 倍数(素材级 LTV 形状,异常低=吸的低质用户)。
- 我们缺 3s views(hook rate)/hold rate/frequency:EVR 是 hook+hold 合并 proxy;疲劳判定走"自身历史基线对比"路线。
- IPM 行业参考:休闲 8~15,超休闲 25~40(AppLovin 2025)。判定一律用项目内相对基准,绝对值只作底线。

## 生命周期评级规则(build-material.js)

| 评级 | 判定 | 动作 |
|---|---|---|
| 🧪测试中 | 消耗<$15 或 曝光<3k(曝光<1k 完全不读数) | 继续投,达门槛再判 |
| 🔴止损 | ≥$30 且 ≥5k曝光,IPM<项目中位×0.5 且 CTR<中位×0.6;或 ROI≤中位×0.5 | 关停 |
| ⚠️疲劳衰退 | ≥$30,相对**自身峰值7日窗口**:CTR -20%/IPM -25%/CPM +18%/ROI -30%/跑量萎缩,≥2信号或ROI单独触发 | Refresh:减预算50%+换hook迭代;CTR -40% → Replace 立即停 |
| 🚀机会素材 | $15~60、≥10安装(双门槛防假winner),ROI≥max(中位,0.25),且 IPM≥中位×1.3 或 CPI≤中位×0.8 | 加量20~30%/次,勿翻倍重置学习期 |
| 🌟主力素材 | ≥$60 且 ROI≥max(中位×1.05, 0.2) | 放量,盯疲劳;1个衰减信号=Watch备替补 |
| ✅在投 | 其余 | 正常轮换 |

要点:衰减顺序 **CTR先掉→CPM涨→CVR乱→ROAS最后崩**,等 ROAS 掉再反应已错过窗口,所以疲劳以前端指标为先导。
中位数基准只取有效样本(素材消耗≥$10 且曝光≥1k)。门槛值按我们的小盘子(单项目日耗几十刀)较行业惯例($50/10k曝光)等比例下调。

TikTok 素材生命周期 3~10 天(快于 Meta),官方建议 ≥每7天上新;月产 <10 条素材的账户 6~8 周内必现疲劳。

## 实时监控规则(track-hourly.js)

- **pacing 三线**:今日 vs 昨日同时点 vs 近7日同时点均值(时录表 日标记 ①②③;固定绝对阈值不可靠,一律相对偏离)。
- **预警触发**(实时预警表,每小时整表重算):
  - 断量:基线≥$10 而今日≈0 → 🔴 查账户/审核/出价
  - 消耗偏离基线 ±40%:超速且 ROI<基线×0.7 → 🔴 降预算;超速但 ROI 达标 → 🟡 不动;骤降 → 🟡 查衰退/竞价
  - ROI 连续 **3 小时** < 7日同时段基线×0.7 → 🔴(单小时跳水不动作——小时级 ROAS 噪音大,D0 付费集中晚间,必须同时段比)
  - 游戏级:今日≥$10 且 ROI<0.15 → 🔴;消耗 ≥昨日同时点×2.5 → 🟡
- 判读口诀:**超速+ROI达标=不动;超速+ROI低=降预算;断量=查账户;ROI单点跳水=等,连续3小时=动手。**

## 测试纪律(供投放执行参考,系统不强制)

- 测试前书面约定 winner/kill 标准;每条素材 $50~200 测试预算、3~5 天出结论;复制已起量 plan 只换素材。
- 1k 曝光只做方向判断,5k+ 才做预算决策;IPM/CTR 信号需 ≥20 安装,ROAS 信号需 ≥50 安装(我们按盘子缩到 10/20)。
- 每周 5~10 个新概念是健康产能;头部 10% 素材贡献 80% 安装属正常,榜单+集中度是第一屏。

## 已知缺口

- 无素材标签体系(hook类型/玩法/风格)→ AppsFlyer 式"元素级归因"做不了;素材命名若带规则可后续解析。
- 无 frequency / first-time impression ratio → 受众饱和不可测,只能从 CPM 上涨间接推断。
- EVR 低只说明"前6秒整体失败",分不清开头还是中段问题,需人工看素材。

## 来源

Gamigion 测试清单 https://www.gamigion.com/creative-testing-checklist/ · Admiral Media 测试框架 https://admiral.media/creative-testing-framework-mobile-apps/ · Triple Whale 疲劳三档 https://www.triplewhale.com/blog/creative-fatigue · Segwise(测试/TikTok疲劳/基准)https://segwise.ai/blog/ · Motion 创意分析 https://motionapp.com/blog/creative-analytics-101-everything-you-need-to-know · AppsFlyer 创意优化 https://www.appsflyer.com/resources/reports/creative-optimization/ · Sprinklr pacing 异常检测 https://www.sprinklr.com/help/ · Madgicx 疲劳检测 https://madgicx.com/blog/creative-fatigue-detection · TikTok 指标文档 https://ads.tiktok.com/help/article/all-metrics
