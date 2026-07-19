// Designed with Claude (Anthropic)
//
// buildAnalysisPayload — the structured JSON the analyst model sees.
//
// v9.8 item 5: the analyst is handed ONLY public economic series as data, one
// object per panel, with series_id, display_label (matching the Method tab),
// explicit unit, latest_value/date, yoy_change where applicable, a streak
// (count + cadence), a threshold (value + rule), and — for differential panels —
// BOTH sides' own values, never just the gap. The mislabel-era prose ("web/
// internet-search jobs", the mirrored ±X.XX halves) came from feeding the model
// framed prose and gap-only numbers; a both-sides structured payload removes
// both failure modes at the source.
//
// The streak + trigger math is a faithful port of the app's StatusTrend.kt /
// Watch.kt so the analyst's "how long" language cannot diverge from the panels:
// same COVID-excluded baseline, same 36-month minimum, same 2-sigma trigger.
// NOTE: mechanical verdict LABELS (Steady/Watch/Break) are deliberately NOT in
// the payload — the analysis is an independent read of the same numbers, not a
// paraphrase of the stoplight. Streaks are worded as conditions, not verdicts.

// All registered values come from config.mjs — one home, no per-file copies
// (audit-2026-07 findings 5, 6, 7, 9, 21).
import {
  COVID_START, COVID_END, WATCH_MIN_HISTORY, TRAILING_WINDOW, WATCH_Z, BREAK_Z,
  PROD_BAND_LOW, PROD_BAND_HIGH, PROD_BREAK_RUN_QUARTERS,
  ADOPTION_RISING_LOOKBACK, TREND_DRIFT_Z, TREND_LOOKBACK_READINGS,
  DIFFERENTIALS, LABOR_SHARE_CHANGE_QUARTERS, LABOR_SHARE_BASELINE_QUARTERS,
} from "./config.mjs";

const sorted = (obs) => [...(obs ?? [])].sort((a, b) => a.date.localeCompare(b.date));
const ymOf = (d) => d.slice(0, 7);
const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

function ymAdd(ym, n) {
  const [y, m] = ym.split("-").map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${String(Math.floor(t / 12)).padStart(4, "0")}-${String((t % 12) + 1).padStart(2, "0")}`;
}
// FRED dates quarterly obs at the first day of the quarter; report at quarter end.
const quarterEndMonth = (d) => ymAdd(ymOf(d), 2);

/** YoY % growth keyed by month, needing the same month 12 periods earlier. */
function yoyByMonth(obs) {
  const byMonth = new Map(sorted(obs).map((o) => [ymOf(o.date), o.value]));
  const out = new Map();
  for (const [m, v] of byMonth) {
    const prior = byMonth.get(ymAdd(m, -12));
    if (prior != null && prior !== 0) out.set(m, (v / prior - 1) * 100);
  }
  return out;
}

/** Average of several ids' YoY-by-month, keeping only months where all are present. */
function avgYoyDiffSeries(exposedIds, controlIds, series) {
  const ex = exposedIds.map((id) => yoyByMonth(series[id]));
  const co = controlIds.map((id) => yoyByMonth(series[id]));
  const months = new Set();
  for (const m of [...ex, ...co]) for (const k of m.keys()) months.add(k);
  const pts = [];
  for (const m of [...months].sort()) {
    const exVals = ex.map((x) => x.get(m)).filter((v) => v != null);
    const coVals = co.map((x) => x.get(m)).filter((v) => v != null);
    if (exVals.length !== ex.length || coVals.length !== co.length) continue;
    const exAvg = exVals.reduce((a, b) => a + b, 0) / exVals.length;
    const coAvg = coVals.reduce((a, b) => a + b, 0) / coVals.length;
    pts.push({ month: m, exposed: exAvg, control: coAvg, diff: exAvg - coAvg });
  }
  return pts;
}

const keepExCovid = (dated) =>
  dated.filter(([m]) => m < COVID_START || m > COVID_END).map(([, v]) => v);

function zScore(latest, historyVals) {
  if (historyVals.length < WATCH_MIN_HISTORY) return null;
  const mean = historyVals.reduce((a, b) => a + b, 0) / historyVals.length;
  const sd = Math.sqrt(historyVals.reduce((a, b) => a + (b - mean) ** 2, 0) / historyVals.length);
  if (sd < 1e-9) return null;
  return (latest - mean) / sd;
}
const stateForZ = (z) => (z == null ? "steady" : z >= BREAK_Z ? "break" : z >= WATCH_Z ? "watch" : "steady");

/** The panel's trigger value in its own units (one-tailed 2-sigma off the calm baseline). */
function twoSigmaTrigger(dated, upperSide) {
  const vals = keepExCovid(dated);
  if (vals.length < WATCH_MIN_HISTORY) return null;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
  if (sd < 1e-9) return null;
  return upperSide ? mean + BREAK_Z * sd : mean - BREAK_Z * sd;
}

function elapsed(months) {
  if (months <= 0) return "new this reading";
  if (months < 12) return `${months} ${months === 1 ? "month" : "months"}`;
  const y = Math.floor(months / 12), m = months % 12;
  return m === 0 ? `${y} ${y === 1 ? "year" : "years"}` : `${y}y ${m}m`;
}

/**
 * Reconstruct a panel's condition at every reading from its own trailing z, then
 * report the consecutive run + drift — the same as StatusTrend.panelTrend, but
 * WITHOUT the verdict word. [oriented] is [month, value] with higher = more
 * toward displacement. Returns a plain-English streak string, or null.
 */
function streakString(oriented, cadence) {
  const states = [];
  const zs = [];
  for (let i = 0; i < oriented.length; i++) {
    const hist = oriented.slice(0, i).slice(-TRAILING_WINDOW);
    const z = zScore(oriented[i][1], keepExCovid(hist));
    if (z == null) continue;
    states.push([oriented[i][0], stateForZ(z)]);
    zs.push(z);
  }
  if (!states.length) return null;
  const current = states[states.length - 1][1];
  let consecutive = 0;
  let start = states[states.length - 1][0];
  for (let j = states.length - 1; j >= 0; j--) {
    if (states[j][1] === current) { consecutive++; start = states[j][0]; } else break;
  }
  const [sy, sm] = start.split("-").map(Number);
  const [ey, em] = states[states.length - 1][0].split("-").map(Number);
  const months = (ey * 12 + em) - (sy * 12 + sm);
  let drift = "holding roughly flat";
  if (zs.length >= TREND_LOOKBACK_READINGS) {
    const d = zs[zs.length - 1] - zs[zs.length - TREND_LOOKBACK_READINGS];
    if (d > TREND_DRIFT_Z) drift = "drifting further toward weakness";
    else if (d < -TREND_DRIFT_Z) drift = "recovering";
  }
  const condition = current === "steady"
    ? "inside its normal range"
    : current === "watch" ? "modestly past its alarm line" : "well past its alarm line";
  const noun = consecutive === 1 ? "reading" : "readings";
  return `${consecutive} consecutive ${cadence} ${noun} ${condition} (${elapsed(months)}), ${drift}`;
}

/**
 * Worker share of national income: 100 * GDICOMP / GDI per quarter — the ONE
 * place the data repo computes the share (audit-2026-07 finding 1; the ratio,
 * not the raw series, is the panel input).
 */
function laborShareSeries(series) {
  const gdi = new Map(sorted(series.GDI).map((o) => [o.date, o.value]));
  return sorted(series.GDICOMP)
    .filter((o) => (gdi.get(o.date) ?? 0) !== 0)
    .map((o) => ({ date: o.date, value: (o.value / gdi.get(o.date)) * 100 }));
}

/** Consecutive trailing quarters the series has fallen vs the prior quarter. */
function declineStreakQuarters(obs) {
  const s = sorted(obs);
  let run = 0;
  for (let i = s.length - 1; i > 0; i--) {
    if (s[i].value < s[i - 1].value) run++; else break;
  }
  return run;
}

/**
 * Current displacement state of an oriented series (higher = more toward
 * displacement). Mirrors the last iteration of streakString / Watch.kt's
 * stateForZ(zScoreExCovid(...)) — same trailing-120 window, same COVID exclusion.
 */
function currentDisplacementState(oriented) {
  if (!oriented.length) return "steady";
  const hist = oriented.slice(0, -1).slice(-TRAILING_WINDOW);
  const z = zScore(oriented[oriented.length - 1][1], keepExCovid(hist));
  return stateForZ(z);
}

/**
 * The three confounder-robust differentials that VOTE in the displacement chain,
 * as "steady" | "watch" | "break". Fed to analyst/verdict.mjs so the Analyst
 * verdict derives from the same panel state as the on-device stoplight.
 */
export function votingPanelStates(pool, extras = {}) {
  const series = pool.fred.series ?? {};
  const jobs = avgYoyDiffSeries(DIFFERENTIALS.jobs.exposed, DIFFERENTIALS.jobs.control, series);
  const wages = avgYoyDiffSeries(DIFFERENTIALS.wages.exposed, DIFFERENTIALS.wages.control, series);
  const postings = extras.postingsPoints ?? [];
  return {
    jobs: currentDisplacementState(jobs.map((p) => [p.month, -p.diff])),
    wages: currentDisplacementState(wages.map((p) => [p.month, -p.diff])),
    postings: currentDisplacementState(postings.map((p) => [p.date.slice(0, 7), -p.spread])),
  };
}

/**
 * The two BLS-revisable voting differentials as full monthly series
 * ({month, diff} in pp). Used by heavy-revision detection (audit-2026-07
 * finding 10): a logged month's differential moving on a later re-read of the
 * same reference month means the inputs were revised.
 */
export function votingDifferentialSeries(pool) {
  const series = pool.fred.series ?? {};
  return {
    jobs: avgYoyDiffSeries(DIFFERENTIALS.jobs.exposed, DIFFERENTIALS.jobs.control, series),
    wages: avgYoyDiffSeries(DIFFERENTIALS.wages.exposed, DIFFERENTIALS.wages.control, series),
  };
}

export function buildAnalysisPayload(pool, extras = {}) {
  const series = pool.fred.series ?? {};
  const panels = [];

  // --- Productivity (band rule, not z) ---
  {
    const s = sorted(series.PRS85006091);
    const last = s.length ? s[s.length - 1] : null;
    // consecutive quarters in the current band bucket (below / inside / above)
    const bucket = (v) => (v >= PROD_BAND_HIGH ? "above" : v >= PROD_BAND_LOW ? "inside" : "below");
    let run = 0;
    if (last) {
      const cur = bucket(last.value);
      for (let i = s.length - 1; i >= 0; i--) { if (bucket(s[i].value) === cur) run++; else break; }
    }
    const where = last ? (last.value >= PROD_BAND_HIGH ? `above the ${PROD_BAND_HIGH} upper line`
      : last.value >= PROD_BAND_LOW ? `inside the ${PROD_BAND_LOW} to ${PROD_BAND_HIGH} band` : `below the ${PROD_BAND_LOW} lower line`) : null;
    panels.push({
      panel: "labor_productivity",
      series_id: "PRS85006091",
      display_label: "Labor productivity, output per hour",
      unit: "percent (change from a year earlier)",
      latest_value: round1(last?.value),
      latest_date: last ? quarterEndMonth(last.date) : null,
      streak: last ? `${run} consecutive quarterly ${run === 1 ? "reading" : "readings"} ${where}` : null,
      threshold: { band_low: PROD_BAND_LOW, band_high: PROD_BAND_HIGH, rule: `output per hour above ${PROD_BAND_HIGH} percent for ${PROD_BREAK_RUN_QUARTERS === 2 ? "two" : PROD_BREAK_RUN_QUARTERS} straight quarters is the break; the ${PROD_BAND_LOW} to ${PROD_BAND_HIGH} band is the internet-boom pace` },
    });
  }

  // --- Exposed vs control JOBS (Type D differential; both sides) ---
  {
    const pts = avgYoyDiffSeries(DIFFERENTIALS.jobs.exposed, DIFFERENTIALS.jobs.control, series);
    const last = pts[pts.length - 1] ?? null;
    const trigger = twoSigmaTrigger(pts.map((p) => [p.month, p.diff]), false);
    panels.push({
      panel: "exposed_vs_control_jobs",
      series_id: "CES exposed (information, professional/business, financial) vs control (construction, leisure/hospitality, education/health)",
      display_label: "Jobs: AI-exposed vs control industries",
      unit: "percent (year-over-year job growth)",
      exposed_value: round1(last?.exposed),
      control_value: round1(last?.control),
      differential_exposed_minus_control: round1(last?.diff),
      latest_date: last?.month ?? null,
      streak: streakString(pts.map((p) => [p.month, -p.diff]), "monthly"),
      threshold: { differential_trigger: round1(trigger), rule: "the alarm is the exposed-minus-control gap falling two standard deviations below its own calm-period average (a wide but steady gap is not the alarm; the gap widening is)" },
    });
  }

  // --- Exposed vs control WAGES (Type D differential; both sides) ---
  {
    const pts = avgYoyDiffSeries(DIFFERENTIALS.wages.exposed, DIFFERENTIALS.wages.control, series);
    const last = pts[pts.length - 1] ?? null;
    const trigger = twoSigmaTrigger(pts.map((p) => [p.month, p.diff]), false);
    panels.push({
      panel: "exposed_vs_control_wages",
      series_id: "CES average hourly earnings, same exposed vs control industries as the jobs panel",
      display_label: "Pay: AI-exposed vs control industries",
      unit: "percent (year-over-year pay growth)",
      exposed_value: round1(last?.exposed),
      control_value: round1(last?.control),
      differential_exposed_minus_control: round1(last?.diff),
      latest_date: last?.month ?? null,
      streak: streakString(pts.map((p) => [p.month, -p.diff]), "monthly"),
      threshold: { differential_trigger: round1(trigger), rule: "the alarm is exposed pay growth falling two standard deviations below control's, off the calm-period average" },
    });
  }

  // --- Job postings spread (Indeed; both sides) ---
  {
    const pp = extras.postingsPoints ?? [];
    const last = pp[pp.length - 1] ?? null;
    const trigger = twoSigmaTrigger(pp.map((p) => [p.date.slice(0, 7), p.spread]), false);
    panels.push({
      panel: "job_postings_spread",
      series_id: "Indeed Hiring Lab job postings, exposed knowledge-work occupations vs control hands-on occupations",
      display_label: "Job postings: exposed vs control occupations",
      unit: "index points (Feb 2020 = 100)",
      exposed_value: last ? Math.round(last.exposed) : null,
      control_value: last ? Math.round(last.control) : null,
      spread_exposed_minus_control: last ? Math.round(last.spread) : null,
      spread_change_over_6_months: last && pp.length > 6 ? Math.round(last.spread - pp[pp.length - 7].spread) : null,
      latest_date: last ? last.date.slice(0, 7) : null,
      streak: streakString(pp.map((p) => [p.date.slice(0, 7), -p.spread]), "monthly"),
      threshold: { spread_trigger: trigger == null ? null : Math.round(trigger), rule: "postings lead hiring, so a spread two standard deviations below its calm-period average is an early version of the jobs alarm" },
    });
  }

  // --- Worker share of income (Card 2; audit-2026-07 finding 1 re-registration) ---
  // GDICOMP/GDI, a true percent of national income, quarterly back to 1947.
  // Registered rule: the change over LABOR_SHARE_CHANGE_QUARTERS quarters,
  // z-scored against its own trailing LABOR_SHARE_BASELINE_QUARTERS history of
  // such changes, COVID-excluded, latest excluded — acceleration, not level,
  // with no fitted trend line (the old post-1980 detrend on PRS85006173 is
  // retired; its reading depended on the fit window).
  {
    const share = laborShareSeries(series);
    const last = share.length ? share[share.length - 1] : null;
    const changes = [];
    for (let i = LABOR_SHARE_CHANGE_QUARTERS; i < share.length; i++) {
      changes.push([quarterEndMonth(share[i].date), share[i].value - share[i - LABOR_SHARE_CHANGE_QUARTERS].value]);
    }
    const latestChange = changes.length ? changes[changes.length - 1][1] : null;
    const trigger = twoSigmaTrigger(changes.slice(0, -1).slice(-LABOR_SHARE_BASELINE_QUARTERS), false);
    const decl = declineStreakQuarters(share);
    panels.push({
      panel: "worker_share_of_income",
      series_id: "GDICOMP/GDI",
      display_label: "Worker share of national income",
      unit: "percent (of gross domestic income)",
      latest_value: round1(last?.value),
      latest_date: last ? quarterEndMonth(last.date) : null,
      change_over_4_quarters: round1(latestChange),
      streak: last ? `${decl} consecutive quarterly ${decl === 1 ? "decline" : "declines"}` : null,
      threshold: { change_trigger: round1(trigger), rule: `the alarm is the share falling over ${LABOR_SHARE_CHANGE_QUARTERS} quarters ${BREAK_Z} standard deviations faster than its trailing thirty-year norm of such changes (pandemic years excluded); acceleration, not level, is the tell` },
    });
  }

  // --- Recent-grad unemployment gap (supplemental) ---
  {
    const g = extras.inversion ?? null;
    panels.push({
      panel: "recent_grad_gap",
      series_id: "CGBD2024 minus UNRATE (recent-college-graduate unemployment rate minus the general rate)",
      display_label: "Recent-graduate unemployment gap",
      unit: "percentage points",
      latest_value: g ? round1(g.gapPct) : null,
      streak: g ? `${g.runMonths} consecutive ${g.runMonths === 1 ? "month" : "months"} with graduates unemployed at a higher rate than the general workforce` : null,
      shading_rule: "the panel highlights months where this gap sits above its own trailing ten-year average",
      above_trailing_10yr_average: g ? g.anomalous : null,
      threshold: { rule: "supplemental context only; this panel does not by itself move the headline" },
    });
  }

  // --- AI adoption (Type B gate) ---
  {
    const ap = extras.adoptionPoints ?? [];
    const last = ap[ap.length - 1] ?? null;
    const rising = ap.length >= 2 && last.pct > ap[Math.max(0, ap.length - ADOPTION_RISING_LOOKBACK)].pct;
    panels.push({
      panel: "ai_adoption",
      series_id: "US Census Bureau Business Trends and Outlook Survey, share of firms using AI",
      display_label: "Firms using AI in any business function",
      unit: "percent (of firms)",
      latest_value: last ? round1(last.pct) : null,
      latest_date: last?.date ?? null,
      direction: last ? (rising ? "rising" : "flat") : null,
      series_break_note: "the series starts November 2025, when the Census question changed from 'producing goods or services' to 'any business function'; earlier readings are not comparable",
      threshold: { rule: "a weak-form deployment gate: any real adoption permits a displacement reading but never causes one on its own" },
    });
  }

  // --- How AI is used: automation vs augmentation ---
  {
    const aei = extras.aeiPoints ?? [];
    const last = aei[aei.length - 1] ?? null;
    panels.push({
      panel: "ai_use_automation_vs_augmentation",
      series_id: "Anthropic Economic Index, share of AI conversations that automate a task vs augment the person",
      display_label: "How AI is used: automation vs augmentation",
      unit: "percent (of sampled AI conversations)",
      automation_value: last ? round1(last.automatePct) : null,
      augmentation_value: last ? round1(last.augmentPct) : null,
      latest_date: last?.date ?? null,
      threshold: { rule: "a slow research series; a rising automation share only raises the displacement reading when adoption is also rising and exposed work is weakening" },
    });
  }

  // --- Macro regime gate ---
  {
    const macro = extras.macro ?? {};
    panels.push({
      panel: "macro_regime",
      series_id: "DFII10 (10-year real Treasury yield), T10Y2Y and T10Y3M (yield-curve spreads), T10YIE (10-year expected inflation)",
      display_label: "Macro regime",
      unit: "percent",
      real_10yr_yield: round1(macro.realYield10y),
      yield_curve_10yr_minus_2yr: round1(macro.termSpread10y2y),
      expected_inflation_10yr: round1(macro.breakeven10y),
      yield_curve_inverted: macro.recessionSignal ?? null,
      threshold: { rule: "an inverted yield curve is the bond market independently pricing an ordinary recession, which argues against an AI-specific reading" },
    });
  }

  // --- AI capability: METR task-length horizons ---
  {
    const top = extras.metrTop5 ?? [];
    panels.push({
      panel: "ai_capability_metr",
      series_id: "METR task-completion time horizons of frontier AI models",
      display_label: "AI capability: task-length horizon",
      unit: "minutes of human working time",
      top_models_by_80pct_horizon: top.map((m) => ({
        model: m.model, lab: m.lab,
        horizon_80pct_minutes: m.p80Min == null ? null : Math.round(m.p80Min),
        horizon_50pct_minutes: m.p50Min == null ? null : Math.round(m.p50Min),
      })),
      threshold: { rule: "a capability gate: the 80 percent horizon is the level where a task can be handed off rather than checked; this permits but never causes a displacement reading" },
    });
  }

  // --- AI capability: normalized benchmark tracks ---
  {
    const slots = extras.slots ?? [];
    panels.push({
      panel: "ai_capability_benchmarks",
      series_id: "tracked capability benchmarks (reasoning, coding, biology)",
      display_label: "AI capability: benchmark tracks",
      unit: "index points (0 to 100)",
      tracks: slots.map((s) => ({
        track: s.slot, benchmark: s.benchmarkName,
        latest_score: s.latestScore == null ? null : Math.round(s.latestScore),
        latest_date: s.latestDate ?? null,
        nearing_saturation: s.saturated ?? null,
      })),
      threshold: { rule: "context on the capability curve; lower confidence than the time-horizon measure" },
    });
  }

  return panels;
}
