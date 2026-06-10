/**
 * Cloudflare Worker — punctual trigger for the GitHub Actions workflows.
 *
 * Cloudflare cron triggers fire on UTC. We map:
 *   08:00 UTC = 16:00 BJT → daily-product.yml
 *   23:00 UTC = 07:00 BJT → daily-ads.yml
 *
 * On a failed dispatch it pings the Feishu bot so a missed trigger is never silent.
 *
 * Secrets (set via `wrangler secret put` or the dashboard):
 *   GH_PAT          GitHub fine-grained PAT, Actions: Read and write on the repo
 *   FEISHU_WEBHOOK  Feishu custom-bot webhook URL (optional, for alerts)
 * Vars (wrangler.toml [vars]):
 *   REPO            e.g. "peter-xiao1989/tiktok-scraper"
 */

export default {
  async scheduled(event, env, ctx) {
    // One cron "0 8,23 * * *" fires at both 08:00 and 23:00 UTC (free plan caps
    // cron triggers, so we use a single trigger). event.cron is the whole string,
    // so route by the fired hour instead.
    const hour = new Date(event.scheduledTime).getUTCHours();
    const workflow = hour === 8 ? 'daily-product.yml'   // 16:00 BJT
                   : hour === 23 ? 'daily-ads.yml'      // 07:00 BJT
                   : null;
    if (!workflow) { console.log(`unexpected hour ${hour}, skip`); return; }

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
  },
};
