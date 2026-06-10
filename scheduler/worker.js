/**
 * Cloudflare Worker — punctual trigger for the GitHub Actions workflows.
 *
 * One cron "0 * * * *" fires every hour (free plan caps cron triggers, so it's a
 * single trigger). event.cron is the whole string, so we route by the fired UTC hour:
 *   every hour            → realtime.yml        (分时, 每小时)
 *   08:00 UTC = 16:00 BJT → + daily-product.yml
 *   23:00 UTC = 07:00 BJT → + daily-ads.yml
 *
 * A failed dispatch pings the Feishu bot so a missed trigger is never silent.
 *
 * Secrets (wrangler secret put):
 *   GH_PAT          GitHub fine-grained PAT, Actions: Read and write on the repo
 *   FEISHU_WEBHOOK  Feishu custom-bot webhook URL (optional, for alerts)
 * Vars (wrangler.toml [vars]):
 *   REPO            e.g. "peter-xiao1989/tiktok-scraper"
 */

function tasksForHour(hour) {
  const t = ['realtime.yml'];                    // 每小时 → 分时数据
  if (hour === 8) t.push('daily-product.yml');   // 16:00 BJT 产品数据
  if (hour === 23) t.push('daily-ads.yml');      // 07:00 BJT 投放数据
  return t;
}

async function trigger(workflow, env) {
  const res = await fetch(
    `https://api.github.com/repos/${env.REPO}/actions/workflows/${workflow}/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GH_PAT}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'cf-worker-scheduler',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: 'main' }),
    }
  );
  if (!res.ok && env.FEISHU_WEBHOOK) {
    const body = await res.text();
    await fetch(env.FEISHU_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        msg_type: 'text',
        content: { text: `❌ 触发 ${workflow} 失败: HTTP ${res.status}\n${body.slice(0, 200)}` },
      }),
    });
  }
  console.log(`dispatch ${workflow}: ${res.status}`);
}

export default {
  async scheduled(event, env, ctx) {
    const hour = new Date(event.scheduledTime).getUTCHours();
    const tasks = tasksForHour(hour);
    if (!tasks.length) { console.log(`hour ${hour}: nothing to trigger`); return; }
    for (const wf of tasks) await trigger(wf, env);
  },
};
