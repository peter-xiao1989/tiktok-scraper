/**
 * Rewrite every formula-driven derived table to force Feishu to recalculate.
 *
 * Feishu spreadsheets do NOT auto-recalc formulas when their source data is
 * written via the API — the formulas hold a stale snapshot until rewritten.
 * So after each data import we re-emit the formulas (which triggers recalc).
 *
 * Called by both ads-api.js (07:00, after 投放 data) and product-api.js (16:00,
 * after 产品 data) so every table reflects the latest import promptly.
 *
 * Order matters: 项目维度经营表 first (the 日报表 sort key reads its day spend).
 */

const { ensureProjectSummary, ensureDailySummary, ensureAdProductSummary,
        ensureAdMaterialSummary, ensureAdBidSummary } = require('./build-summaries');
const { ensureReportFormulas } = require('./build-report');

async function maintainAllDerived(token) {
  const steps = [
    ['项目维度经营表', ensureProjectSummary],
    ['产品经营日报表', ensureReportFormulas],
    ['日经营数据汇总', ensureDailySummary],
    ['投放日表-产品维度', ensureAdProductSummary],
    ['投放日表-素材维度', ensureAdMaterialSummary],
    ['投放日表-出价维度', ensureAdBidSummary],
  ];
  for (const [name, fn] of steps) {
    try {
      console.log(`Maintaining ${name}...`);
      await fn(token);
    } catch (e) {
      console.warn(`[warn] ${name} maintenance: ${e.message}`);
    }
  }
}

module.exports = { maintainAllDerived };
