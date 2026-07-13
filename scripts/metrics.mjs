// Designed with Claude (Anthropic)
// JS port of the summary numbers the app derives in domain/Metrics.kt —
// used ONLY to build the analysis prompt from the pool's raw FRED series.
// The Android app still does its own on-device computation; keep the two in
// sync if the app's rules ever change.

const PRODUCTIVITY_BAND_LOW_PCT = 2.7;
const PRODUCTIVITY_BAND_HIGH_PCT = 3.4;
const INVERSION_TRAILING_WINDOW_MONTHS = 120;
const INVERSION_MIN_HISTORY_MONTHS = 36;
const SECTOR_PEAK_WINDOW_START = "2021-01-01";

const SECTOR_NAMES = {
  USINFO: "Information sector",
  TEMPHELPS: "Temporary-help services",
  CES6054150001: "Internet publishing and web search",
};

const ymOf = (dateStr) => dateStr.slice(0, 7);
function ymAdd(ym, n) {
  const [y, m] = ym.split("-").map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${String(Math.floor(t / 12)).padStart(4, "0")}-${String((t % 12) + 1).padStart(2, "0")}`;
}
// FRED dates quarterly observations at the first day of the quarter; align
// each quarter to its final month (Q1 -> March, etc.).
const quarterEndMonth = (dateStr) => ymAdd(ymOf(dateStr), 2);

const sorted = (obs) => [...(obs ?? [])].sort((a, b) => a.date.localeCompare(b.date));

function computeGdpEmployment(gdp, payems) {
  const gdpYoY = new Map();
  for (let i = 4; i < gdp.length; i++) {
    gdpYoY.set(quarterEndMonth(gdp[i].date), (gdp[i].value / gdp[i - 4].value - 1) * 100);
  }
  const gdpMonths = [...gdpYoY.keys()];
  const gaps = [];
  for (let i = 12; i < payems.length; i++) {
    const month = ymOf(payems[i].date);
    const pYoY = (payems[i].value / payems[i - 12].value - 1) * 100;
    let g = null;
    for (const gm of gdpMonths) if (gm <= month) g = gdpYoY.get(gm);
    if (g != null) gaps.push(g - pYoY);
  }
  return {
    gapPct: gaps.length ? gaps[gaps.length - 1] : null,
    avgGapPct: gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null,
  };
}

function computeProductivity(gdp, payems) {
  const payemsByMonth = new Map(payems.map((o) => [ymOf(o.date), o.value]));
  const ratios = [];
  for (const obs of gdp) {
    const month = quarterEndMonth(obs.date);
    const p = payemsByMonth.get(month);
    if (p != null) ratios.push(obs.value / p);
  }
  let growth = null;
  for (let i = 4; i < ratios.length; i++) growth = (ratios[i] / ratios[i - 4] - 1) * 100;
  return {
    growthPct: growth,
    flagged: growth != null && growth > PRODUCTIVITY_BAND_HIGH_PCT,
    bandLowPct: PRODUCTIVITY_BAND_LOW_PCT,
    bandHighPct: PRODUCTIVITY_BAND_HIGH_PCT,
  };
}

function computeSector(obs) {
  const inWindow = obs.filter((o) => o.date >= SECTOR_PEAK_WINDOW_START);
  const peak = inWindow.length ? Math.max(...inWindow.map((o) => o.value)) : 0;
  if (!peak) return { level: null, delta6mo: null };
  const indexed = obs.map((o) => (o.value / peak) * 100);
  const level = indexed[indexed.length - 1] ?? null;
  const past = indexed[indexed.length - 7] ?? null;
  return { level, delta6mo: level != null && past != null ? level - past : null };
}

function computeInversion(grad, unrate) {
  const unByMonth = new Map(unrate.map((o) => [ymOf(o.date), o.value]));
  const joined = [];
  for (const g of grad) {
    const month = ymOf(g.date);
    const un = unByMonth.get(month);
    if (un != null) joined.push({ month, gap: g.value - un });
  }
  // Run of consecutive inverted (gap > 0) adjacent calendar months, ending at the last point.
  let run = 0;
  for (let i = 0; i < joined.length; i++) {
    const inverted = joined[i].gap > 0;
    run = !inverted ? 0
      : i > 0 && run > 0 && ymAdd(joined[i - 1].month, 1) === joined[i].month ? run + 1
      : 1;
  }
  // Anomalous: latest gap exceeds its own trailing 10-year average.
  let anomalous = false;
  const idx = joined.length - 1;
  if (idx >= 0) {
    const start = Math.max(0, idx - INVERSION_TRAILING_WINDOW_MONTHS);
    const window = joined.slice(start, idx).map((j) => j.gap);
    if (window.length >= INVERSION_MIN_HISTORY_MONTHS) {
      anomalous = joined[idx].gap > window.reduce((a, b) => a + b, 0) / window.length;
    }
  }
  return { gapPct: idx >= 0 ? joined[idx].gap : null, anomalous, runMonths: run };
}

// v9.2/v9.3 panels (simplified latest-value reads for the analysis prompt).
const EXPOSED_IND = ["USINFO", "USPBS", "USFIRE"];
const CONTROL_IND = ["USCONS", "USLAH", "USEHS"];

function yoyLatestAvg(ids, series) {
  const vals = ids.map((id) => {
    const s = sorted(series[id]);
    if (s.length < 13) return null;
    const last = s[s.length - 1].value;
    const prior = s[s.length - 13].value;
    return prior ? (last / prior - 1) * 100 : null;
  }).filter((v) => v != null);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

function lastVal(series, id) { const s = sorted(series[id]); return s.length ? s[s.length - 1].value : null; }

/** Summary of the whole dashboard. `extras` carries the METR + adoption
 *  snapshots (separate files) so the analysis reasons over EVERYTHING. */
export function computeDashboardSummary(pool, extras = {}) {
  const series = pool.fred.series ?? {};
  const gdp = sorted(series.GDPC1);
  const payems = sorted(series.PAYEMS);

  const sectors = ["USINFO", "TEMPHELPS", "CES6054150001"].map((id) => ({
    id, name: SECTOR_NAMES[id], ...computeSector(sorted(series[id])),
  }));

  // Type D: exposed-minus-control (the confounder-robust signal).
  const exYoY = yoyLatestAvg(EXPOSED_IND, series);
  const coYoY = yoyLatestAvg(CONTROL_IND, series);
  const exposedControl = { exposedYoY: exYoY, controlYoY: coYoY, differential: (exYoY != null && coYoY != null) ? exYoY - coYoY : null };

  // Type D: labor share.
  const ls = sorted(series.PRS85006173);
  const laborShare = { latest: ls.length ? ls[ls.length - 1].value : null, changeVs4qAgo: ls.length > 4 ? ls[ls.length - 1].value - ls[ls.length - 5].value : null };

  // Type C: hiring flows (prof & business preferred).
  const hiresS = sorted(series.JTS6000HIR).length ? sorted(series.JTS6000HIR) : sorted(series.JTSHIR);
  const hiringFlows = {
    openingsRate: lastVal(series, "JTS6000JOR") ?? lastVal(series, "JTSJOR"),
    hiresRate: hiresS.length ? hiresS[hiresS.length - 1].value : null,
    hiresChangeYoY: hiresS.length > 12 ? hiresS[hiresS.length - 1].value - hiresS[hiresS.length - 13].value : null,
    layoffsRate: lastVal(series, "JTSLDR"),
  };

  // Type E: macro-regime gate.
  const ts2 = lastVal(series, "T10Y2Y");
  const ts3 = lastVal(series, "T10Y3M");
  const macro = { realYield10y: lastVal(series, "DFII10"), termSpread10y2y: ts2, termSpread10y3m: ts3, breakeven10y: lastVal(series, "T10YIE"), recessionSignal: (ts3 != null && ts3 < 0) || (ts2 != null && ts2 < 0) };

  // METR from the current snapshot (extras), not the vestigial pool points.
  const metrTop5 = (extras.metrRecords ?? [])
    .filter((r) => r.thVersion === "1.1" && r.p80Min != null)
    .sort((a, b) => b.p80Min - a.p80Min).slice(0, 5)
    .map((r) => ({ model: r.model, lab: r.lab, p80Min: r.p80Min, p50Min: r.p50Min }));

  const slotLatest = pool.capability.slots.map((s) => {
    const pts = pool.capability.points
      .filter((p) => p.metricId === "normalized" && p.seriesKey === s.slot)
      .sort((a, b) => a.pointDate.localeCompare(b.pointDate));
    const last = pts[pts.length - 1];
    return { slot: s.slot, benchmarkName: s.benchmarkName, saturated: s.saturated, latestScore: last?.value ?? null, latestDate: last?.pointDate ?? null };
  });

  // Type B: adoption (extras).
  const ap = extras.adoptionPoints ?? [];
  const adoption = ap.length ? { latestPct: ap[ap.length - 1].pct, rising: ap.length >= 2 && ap[ap.length - 1].pct > ap[Math.max(0, ap.length - 4)].pct } : null;

  // AEI: how AI is used — automation (task offload) vs augmentation (collaboration).
  // Soft Type-B modifier: a rising automation share means the AI that IS being
  // adopted is doing more offloading, not just assisting.
  const aei = extras.aeiPoints ?? [];
  const aeiUse = aei.length ? {
    latestAutomatePct: aei[aei.length - 1].automatePct,
    latestAugmentPct: aei[aei.length - 1].augmentPct,
    automateChange: aei.length >= 2 ? aei[aei.length - 1].automatePct - aei[0].automatePct : null,
    latestDate: aei[aei.length - 1].date,
  } : null;

  return {
    productivity: computeProductivity(gdp, payems),
    sectors,
    inversion: computeInversion(sorted(series.CGBD2024), sorted(series.UNRATE)),
    gdpEmployment: computeGdpEmployment(gdp, payems),
    exposedControl, laborShare, hiringFlows, macro, adoption, aeiUse,
    metrTop5,
    slots: slotLatest,
  };
}
