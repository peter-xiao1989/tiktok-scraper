# 准点触发 + 失败告警（已部署）

GitHub 自带的 schedule cron 在高峰期会延迟数小时甚至丢弃（实测产品 cron 从 08:13 UTC 拖到 11:46 UTC）。所以用 **Cloudflare Worker** 精确触发 `workflow_dispatch`（事件驱动、秒级、不排队）；GitHub schedule 保留作兜底；失败时飞书告警。

## 当前部署

- **Worker**：`tiktok-scraper-scheduler`（Cloudflare 账号 xiaohuipeng123）
- **cron**：`0 * * * *`（每小时整点，UTC）— 见 `wrangler.toml`，是单条 trigger（免费版有 5 个 cron 上限）
- **路由**（worker 按触发的 UTC 小时分发，见 `worker.js`）：
  | UTC 小时 | 触发 | 北京时间 |
  |---|---|---|
  | 每小时 | realtime.yml | — |
  | 08 | + daily-product.yml | 16:00 |
  | 23 | + daily-ads.yml | 07:00 |
- **兜底**：各 workflow 的 GitHub schedule 仍在（产品 16:13/16:43、投放 07:17/07:47、分时每 2h），worker 挂掉时延迟兜底
- **告警**：三个 workflow 末尾的 `Notify failure to Feishu` step（`if: failure()`），失败推送到飞书机器人

```
Cloudflare Worker(每小时整点·准点) ──workflow_dispatch──▶ GitHub Actions ──失败──▶ 飞书告警
GitHub schedule cron(兜底·可能延迟数小时) ────────────────▶ (同一 workflow)
```

幂等保证重复触发无害：product-api 覆盖当天行、ads-api 按 account|date 去重、realtime 全表刷新。

## 维护

**改 secret / 换 PAT**（在仓库根的 `scheduler/` 目录）：
```bash
npx wrangler secret put GH_PAT          # GitHub fine-grained PAT, Actions: Read and write
npx wrangler secret put FEISHU_WEBHOOK  # 飞书自定义机器人 webhook(可选,触发失败时告警)
```
> ⚠️ wrangler 需要**交互终端**（真 Terminal.app，不是非交互 shell），否则 `login`/`secret put` 会报 non-interactive。

**改频率 / 重部署**：编辑 `worker.js`（路由）或 `wrangler.toml`（cron），然后 `npx wrangler deploy`。

**失败告警另一半**：GitHub 仓库 Settings → Secrets → `FEISHU_WEBHOOK`（给 workflow 内的告警 step 用；没配则 step 自动跳过）。

## 备选方案：GCP Cloud Scheduler（更准，有 SLA）

如果想换成带 SLA 的方案，`setup-cloud-scheduler.sh` 一条命令建好（需 GCP 项目 + gcloud）。对每天几次的定时，Cloudflare 已经够准，一般不需要。

## 一次性配置 checklist（首次/换机）
- [ ] 飞书自定义机器人 webhook（关键词填 `失败`）→ GitHub secret `FEISHU_WEBHOOK`
- [ ] GitHub fine-grained PAT（Actions: Read and write）→ `wrangler secret put GH_PAT`
- [ ] `npx wrangler deploy`，确认输出 `schedule: 0 * * * *` 无 ERROR
