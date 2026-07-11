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

/** Summary of the whole dashboard, computed from pool.fred.series + pool.capability. */
export function computeDashboardSummary(pool) {
  const series = pool.fred.series ?? {};
  const gdp = sorted(series.GDPC1);
  const payems = sorted(series.PAYEMS);

  const sectors = ["USINFO", "TEMPHELPS", "CES6054150001"].map((id) => ({
    id,
    name: SECTOR_NAMES[id],
    ...computeSector(sorted(series[id])),
  }));

  const p50 = pool.capability.points.filter((p) => p.metricId === "metr" && p.seriesKey === "p50");
  const p80ByLabel = Object.fromEntries(
    pool.capability.points.filter((p) => p.metricId === "metr" && p.seriesKey === "p80").map((p) => [p.label, p.value]),
  );
  const metrTop5 = [...p50].sort((a, b) => b.value - a.value).slice(0, 5)
    .map((p) => ({ label: p.label, date: p.pointDate, p50Minutes: p.value, p80Minutes: p80ByLabel[p.label] ?? null }));

  const slotLatest = pool.capability.slots.map((s) => {
    const pts = pool.capability.points
      .filter((p) => p.metricId === "normalized" && p.seriesKey === s.slot)
      .sort((a, b) => a.pointDate.localeCompare(b.pointDate));
    const last = pts[pts.length - 1];
    return {
      slot: s.slot,
      benchmarkName: s.benchmarkName,
      saturated: s.saturated,
      latestScore: last?.value ?? null,
      latestDate: last?.pointDate ?? null,
    };
  });

  return {
    productivity: computeProductivity(gdp, payems),
    sectors,
    inversion: computeInversion(sorted(series.CGBD2024), sorted(series.UNRATE)),
    gdpEmployment: computeGdpEmployment(gdp, payems),
    metrTop5,
    slots: slotLatest,
  };
}
