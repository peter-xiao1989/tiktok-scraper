const { ensureProjectSummary, ensureDailySummary, ensureAdProductSummary,
        ensureAdMaterialSummary, ensureAdBidSummary, readColsAll } = require('./build-summaries');
const { ensureReportFormulas } = require('./build-report');
const { notifyFeishu, bjtStamp } = require('./notify');

async function maintainAllDerived(token, label = '数据') {
  // 读 uqJEhq 一次,只取近 90 天,所有衍生表共享这份数据(避免重复全量扫)
  const serAny = s => { const str = String(s ?? '').trim(); if (/^\d{5}(\.\d+)?$/.test(str)) return Math.round(+str); const m = /(\d{4})[/-](\d{1,2})[/-](\d{1,2})/.exec(str); return m ? Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 864e5) + 25569 : null; };
  const cutoff = Math.round(Date.now() / 864e5) + 25569 - 90;
  const allAd = await readColsAll(token, 'uqJEhq', 'B', 'AT');
  const adRows = allAd.filter(r => { const s = serAny(r[2]); return s && s >= cutoff; });
  console.log(`  uqJEhq: 共${allAd.length}行, 近90天${adRows.length}行`);

  const steps = [
    ['项目维度经营表',   () => ensureProjectSummary(token, adRows)],
    ['产品经营日报表',   () => ensureReportFormulas(token, adRows)],
    ['日经营数据汇总',   () => ensureDailySummary(token, adRows)],
    ['投放日表-产品维度', () => ensureAdProductSummary(token, adRows)],
    ['投放日表-素材维度', () => ensureAdMaterialSummary(token, adRows)],
    ['投放日表-出价维度', () => ensureAdBidSummary(token, adRows)],
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
