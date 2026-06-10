# CLAUDE.md — tiktok-scraper

TikTok 投放/产品数据 → 飞书电子表格原表 → 衍生汇总表(公式) → 多维表/群报告。

## 数据流与定时

```
TikTok Marketing API ──ads-api(7:00 BJT)──┐
TikTok Developer Portal ─product-api(16:00)─┼─▶ 飞书电子表格原表 ─▶ maintainAllDerived 重写衍生表公式
TikTok realtime ──realtime(每小时*)─────────┘
```

\* 准点触发由 `scheduler/`(Cloudflare worker, cron `0 * * * *`)负责:每小时触发分时,UTC 08:00(16点)加产品,23:00(7点)加投放;GitHub schedule 仅兜底(分时每2h);任一 workflow 失败→飞书机器人告警(secret `FEISHU_WEBHOOK`)。详见 `scheduler/README.md`。

| workflow | 触发 | 干什么 |
|---|---|---|
| daily-ads.yml | 07:00 BJT | 投放数据导入 + 重算衍生表 |
| daily-product.yml | 16:13/16:43 BJT | 产品数据导入 + 重算衍生表 |
| realtime.yml | 每小时(worker)/每2h(cron兜底) | 分时数据 + rebuild_*.py + 多维表同步 |
| daily-reports.yml | 08:10 / 16:40 BJT | 同步多维表(群报告发送被 if:false 门控暂停) |

## 必须知道的机制(违反会出错)

- **飞书公式不会因 API 写入源数据而自动重算**。任何导入后必须调 `maintainAllDerived`(src/maintain-derived.js)重写衍生表公式。顺序固定:项目维度经营表最先(日报表排序键依赖它)。
- **游戏配置权威源 = 电子表格「产品id及链接」(juQobR)**:A=项目组 B=产品名 C=id。无 id 的行跳过产品抓取。加新游戏只在这张表加行,不改代码。
- **衍生表按表头名定位列**(用户会改表头)。改报告列:动 FIELD_SRC/need() 的候选名,别按列号硬编码。匹配不到的列会被**静默跳过**——重跑后核对日志里每个 col 都 done。
- **隐藏 helper 列起点必须随表头列数动态算**(`HELP0 = lastHdr + 3`)。硬编码起点会在加列后覆盖可见列(历史事故:排序键覆盖点击率列显示 2100%)。
- **源表数字是文本**:SUMIFS 自动转换,SUMPRODUCT 必须 `IFERROR(VALUE(范围),0)` 包裹;ROAS 列是百分比文本(`60.00%`),Python 端 fnum 需剥 `%` 再 /100。
- **ROAS 口径**:衍生表的 ROAS = Σ(投放原表消耗×ROAS)/Σ消耗(投放侧加权),**不是** 广告总收入/消耗。
- 写公式量大时分块(≤200行/批)+ 限流重试(90217/90235/Data Not Ready 均为暂时性)。

## 红线

- **FEISHU_APP_SECRET 只能来自环境变量**,严禁回填明文到代码(历史上泄露过一次,已在轮换)。
- 衍生表(JIKPZV/6B1PVx/wAsSso/kX0M0R/TOBfe9 等)的数据全部由公式重算生成,**不要手工往里写值**——下次 maintain 会覆盖。

## 速查

- 电子表格(两个 token 等效,指同一张表):wiki node `J8mswO2vziyIAAkdt4rcVeaDnog`(node 代码 SPREADSHEET_TOKEN 用这个) / 原生 `K8tgsrOpFhxjy3tgDHscJ5jonHh`(python lark-cli 用这个)
- sheet id:投放原表 uqJEhq / 产品原表 c50205 / 分时原表 jArZTX / 日经营 wAsSso / 项目维度 JIKPZV / 各产品日报 6B1PVx / 投放日报-产品 kX0M0R / 投放日报-素材 TOBfe9 / 分时素材 dbGqhL / 产品id及链接 juQobR
- 多维表「TT经营数据中心」:`YB8TbS45kaO1gesMtqlc8kpznEb`(用户身份建;旧 base HCXKb… 用户自维护勿动)
- 游戏选品群:`oc_0d077d9ba6ce793a835b546bd9dbb9e6`
- 本地验证衍生表:`FEISHU_APP_SECRET=… node -e "…ensureReportFormulas/ensureDailySummary…"`(见 src/build-summaries.js exports)
- 外部准点调度:见 `scheduler/README.md`
