# 准点触发 + 失败告警

GitHub 自带的 schedule cron 在高峰期会延迟数小时（甚至偶尔丢）。这里用**外部调度器**精确触发 `workflow_dispatch`（事件驱动、秒级、不排队），GitHub 的 schedule 保留作兜底。失败时飞书告警。

## 架构

```
外部调度器(准点) ──POST workflow_dispatch──▶ GitHub Actions ──失败──▶ 飞书告警
GitHub schedule cron(兜底,可能延迟) ──────────▶ (同一个 workflow)
```

- 触发幂等：product-api 覆盖当天数据，ads-api 按 account|date 去重，重复触发无害。
- 所以「外部准点触发 + GitHub schedule 兜底」两条线同时存在也不会重复写错。

---

## 一、准备（两个方案都需要）

### 1. 飞书机器人 webhook（失败告警）
1. 目标飞书群 → 设置 → 群机器人 → 添加机器人 → **自定义机器人**
2. 安全设置选「自定义关键词」填 `失败`（或先不设校验）
3. 复制 webhook URL
4. GitHub 仓库 → Settings → Secrets and variables → Actions → New repository secret
   - Name: `FEISHU_WEBHOOK`  Value: 上面的 URL

> 不配也行，workflow 里的告警步骤会自动跳过；配上才有失败推送。

### 2. GitHub PAT（外部触发用）
1. GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate new token
2. Repository access: 只勾 `peter-xiao1989/tiktok-scraper`
3. Permissions → Repository permissions → **Actions: Read and write**
4. 生成并复制（只显示一次）

---

## 二、触发方案（二选一）

### 方案 A：GCP Cloud Scheduler（最准，有 SLA — 推荐）

需要 GCP 项目 + `gcloud` CLI + 启用 Cloud Scheduler API。

```bash
GCP_PROJECT=你的项目ID GH_PAT=github_pat_xxx bash scheduler/setup-cloud-scheduler.sh
```

脚本直接用 `Asia/Shanghai` 时区设 16:00 / 07:00，无需自己换算 UTC。

### 方案 B：Cloudflare Workers（免费，够用）

```bash
cd scheduler
npm i -g wrangler
wrangler login
wrangler secret put GH_PAT          # 粘贴 GitHub PAT
wrangler secret put FEISHU_WEBHOOK  # 粘贴飞书 webhook（可选，触发失败时告警）
wrangler deploy
```

cron 在 `wrangler.toml` 里（UTC）：`0 8 * * *`=16点、`0 23 * * *`=7点。

---

## 三、验证

部署后，手动跑一次确认链路通：
- Cloud Scheduler：`gcloud scheduler jobs run daily-product-1600 --location=asia-east1`
- Cloudflare：dashboard 里 Trigger 一次，或等整点

然后到 GitHub Actions 看是否立刻出现一个 `workflow_dispatch` 触发的 run。

## Checklist
- [ ] 飞书机器人 webhook → GitHub secret `FEISHU_WEBHOOK`
- [ ] GitHub fine-grained PAT（Actions: RW）
- [ ] 部署方案 A 或 B
- [ ] 手动触发一次验证链路
- [ ] （建议保留）GitHub schedule cron 作兜底
