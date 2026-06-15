const { ensureProjectSummary, ensureDailySummary, ensureAdProductSummary,
        ensureAdMaterialSummary, ensureAdBidSummary, readColsAll } = require('./build-summaries');
const { ensureReportFormulas } = require('./build-report');
const { notifyFeishu, bjtStamp } = require('./notify');

async function maintainAllDerived(token, label = '数据') {
  // 读 uqJEhq 一次,所有衍生表共享
  const allAd = await readColsAll(token, 'uqJEhq', 'B', 'AT');
  console.log(`  uqJEhq: ${allAd.length} 行`);

  // 素材/出价维度只看近 60 天,其余需要全量(累计ROI 从第1天累加)
  const serAny = s => { const str = String(s ?? '').trim(); if (/^\d{5}(\.\d+)?$/.test(str)) return Math.round(+str); const m = /(\d{4})[/-](\d{1,2})[/-](\d{1,2})/.exec(str); return m ? Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 864e5) + 25569 : null; };
  const cutoff60 = Math.round(Date.now() / 864e5) + 25569 - 60;
  const recentAd = allAd.filter(r => { const s = serAny(r[2]); return s && s >= cutoff60; });
  console.log(`  uqJEhq 近60天: ${recentAd.length} 行`);

  const steps = [
    ['项目维度经营表',    () => ensureProjectSummary(token, allAd)],
    ['产品经营日报表',    () => ensureReportFormulas(token, allAd)],
    ['日经营数据汇总',    () => ensureDailySummary(token, allAd)],
    ['投放日表-产品维度', () => ensureAdProductSummary(token, allAd)],
    ['投放日表-素材维度', () => ensureAdMaterialSummary(token, recentAd)],
    ['投放日表-出价维度', () => ensureAdBidSummary(token, recentAd)],
  ];
  const results = [];
  for (const [name, thunk] of steps) {
    try {
      console.log(`Maintaining ${name}...`);
      await thunk();
      results.push({ name, ok: true });
    } catch (e) {
      console.warn(`[warn] ${name} maintenance: ${e.message}`);
      results.push({ name, ok: false });
    }
  }
  const failed = results.filter(r => !r.ok);
  if (failed.length) {
    const list = results.map(r => `${r.ok ? '✅' : '❌'} ${r.name}`).join('\n');
    await notifyFeishu(`🟡 ${label}·部分衍生表未更新(下次导入自动补) (${bjtStamp()})\n✅ 原表·核心抓取\n${list}`);
  }
  return results;
}

module.exports = { maintainAllDerived };
