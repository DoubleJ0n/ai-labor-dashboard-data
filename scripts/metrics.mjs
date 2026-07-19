// Designed with Claude (Anthropic)
// JS port of the summary numbers the app derives in domain/Metrics.kt —
// used ONLY to build the analysis prompt from the pool's raw FRED series.
// The Android app still does its own on-device computation; keep the two in
// sync if the app's rules ever change.
//
// SCOPE (audit-2026-07 finding 17 / B-4): this file computes ONLY what
// analysis-refresh actually reads — productivity (for the OPHNFB
// cross-check), inversion, macro, adoption, aeiUse, metrTop5, slots. The
// panel payload the analyst sees comes from payload.mjs, the faithful port.
// The old per-panel summaries (gdpEmployment, exposedControl, wages,
// laborShare, sectors, postings) had drifted from the app and were read by
// nothing; they are deleted so a drifted number can never be wired into the
// prompt.

// Registered values come from config.mjs — one home, no per-file copies
// (audit-2026-07 findings 5, 6, 7, 9).
import {
  PROD_BAND_LOW as PRODUCTIVITY_BAND_LOW_PCT,
  PROD_BAND_HIGH as PRODUCTIVITY_BAND_HIGH_PCT,
  INVERSION_TRAILING_WINDOW_MONTHS, INVERSION_MIN_HISTORY_MONTHS,
  COVID_START, COVID_END, ADOPTION_RISING_LOOKBACK,
} from "./config.mjs";

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

/** YoY derived from the OPHNFB index, keyed by quarter-end month (cross-check only). */
function productivityYoYFromIndex(index) {
  const s = sorted(index);
  const out = new Map();
  for (let i = 4; i < s.length; i++) {
    if (s[i - 4].value !== 0) {
      out.set(quarterEndMonth(s[i].date), (s[i].value / s[i - 4].value - 1) * 100);
    }
  }
  return out;
}

/**
 * Productivity Break Test: BLS nonfarm business output per HOUR, year-over-year.
 * [yoy] is PRS85006091, already published as "percent change from quarter one
 * year ago" — used as-is. [index] is OPHNFB, used only to verify it.
 *
 * The 2.7/3.4 band is calibrated on output per HOUR. It must never be computed
 * from GDPC1/PAYEMS (output per JOB), which runs structurally lower and inverts
 * the reading.
 */
function computeProductivity(yoy, index) {
  const s = sorted(yoy);
  const last = s.length ? s[s.length - 1] : null;
  const growth = last ? last.value : null;

  // Cross-check the published series against its own index; a divergence beyond
  // rounding means a bad pull or a FRED revision. Log only — never block the run.
  let crossCheckDiff = null;
  if (last) {
    const derived = productivityYoYFromIndex(index).get(quarterEndMonth(last.date));
    if (derived != null) {
      crossCheckDiff = growth - derived;
      if (Math.abs(crossCheckDiff) > 0.1) {
        console.warn(
          `WARN productivity cross-check: PRS85006091=${growth} vs YoY(OPHNFB)=${derived.toFixed(2)} ` +
          `(diff ${crossCheckDiff.toFixed(2)} pts) at ${last.date} — possible bad pull or FRED revision`,
        );
      }
    }
  }

  return {
    growthPct: growth,
    latestDate: last ? last.date : null,
    flagged: growth != null && growth > PRODUCTIVITY_BAND_HIGH_PCT,
    bandLowPct: PRODUCTIVITY_BAND_LOW_PCT,
    bandHighPct: PRODUCTIVITY_BAND_HIGH_PCT,
    crossCheckDiff,
  };
}

// Item 9: 12-month trailing MA over contiguous months. CGBD2024 is NSA and spikes
// each June with the graduate influx; smoothing before the gap/run/anomaly matches
// the app (Metrics.movingAvg12) so the payload's grad gap is deseasonalized, not
// the ~4.7 June artifact.
function movingAvg12(obs) {
  const s = sorted(obs);
  const out = [];
  for (let i = 11; i < s.length; i++) {
    const w = s.slice(i - 11, i + 1);
    let contiguous = true;
    for (let k = 1; k < 12; k++) if (ymAdd(ymOf(w[k - 1].date), 1) !== ymOf(w[k].date)) { contiguous = false; break; }
    if (contiguous) out.push({ date: s[i].date, value: w.reduce((a, b) => a + b.value, 0) / 12 });
  }
  return out;
}

function computeInversion(grad, unrate) {
  const gradSm = movingAvg12(grad);
  const unByMonth = new Map(movingAvg12(unrate).map((o) => [ymOf(o.date), o.value]));
  const joined = [];
  for (const g of gradSm) {
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
  // Anomalous: latest gap exceeds its own trailing 10-year average,
  // COVID-excluded like every other statistical baseline (audit-2026-07
  // finding 9 / B-3: this path was missing the registered exclusion the
  // app applies, so the analyst could be told the gap is anomalous while
  // the app's shading disagreed).
  let anomalous = false;
  const idx = joined.length - 1;
  if (idx >= 0) {
    const start = Math.max(0, idx - INVERSION_TRAILING_WINDOW_MONTHS);
    const window = joined.slice(start, idx)
      .filter((j) => j.month < COVID_START || j.month > COVID_END)
      .map((j) => j.gap);
    if (window.length >= INVERSION_MIN_HISTORY_MONTHS) {
      anomalous = joined[idx].gap > window.reduce((a, b) => a + b, 0) / window.length;
    }
  }
  return { gapPct: idx >= 0 ? joined[idx].gap : null, anomalous, runMonths: run };
}

function lastVal(series, id) { const s = sorted(series[id]); return s.length ? s[s.length - 1].value : null; }

/** Summary of the whole dashboard. `extras` carries the METR + adoption +
 *  AEI + postings snapshots (separate files) so the analysis reasons over
 *  EVERYTHING. Wages come from the pool's FRED series (CES average hourly
 *  earnings), so they need no extra. */
export function computeDashboardSummary(pool, extras = {}) {
  const series = pool.fred.series ?? {};

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
  const adoption = ap.length ? { latestPct: ap[ap.length - 1].pct, rising: ap.length >= 2 && ap[ap.length - 1].pct > ap[Math.max(0, ap.length - ADOPTION_RISING_LOOKBACK)].pct } : null;

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
    productivity: computeProductivity(series.PRS85006091 ?? [], series.OPHNFB ?? []),
    inversion: computeInversion(sorted(series.CGBD2024), sorted(series.UNRATE)),
    macro, adoption, aeiUse,
    metrTop5,
    slots: slotLatest,
  };
}
