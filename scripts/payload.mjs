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
  BASELINE_START, BASELINE_END, UNUSABLE_START, UNUSABLE_END, OBSERVATION_START,
  BASELINE_MIN_READINGS, BASELINE_REQUIRED_START, BASELINE_START_SLACK_MONTHS,
  BASELINE_EXEMPT_PANELS, WATCH_MIN_HISTORY, WATCH_Z, BREAK_Z,
  PROD_BAND_LOW, PROD_BAND_HIGH, PROD_BREAK_RUN_QUARTERS,
  ADOPTION_RISING_LOOKBACK, TREND_DRIFT_Z, TREND_LOOKBACK_READINGS,
  DIFFERENTIALS, LABOR_SHARE_CHANGE_QUARTERS,
  REABSORPTION, REABSORPTION_CHANGE_MONTHS, REABSORPTION_FAST_CHANGE_MONTHS,
  REABSORPTION_REFERENCE_YEAR, REABSORPTION_SHORTFALL_POINTS,
  ELO_SCALE,
} from "./config.mjs";

const sorted = (obs) => [...(obs ?? [])].sort((a, b) => a.date.localeCompare(b.date));
const ymOf = (d) => d.slice(0, 7);
const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const round2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

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

/**
 * Latest year-over-year employment growth across the exposed industries, as a
 * percent. This is the input to the wage panel's weighting rule: whether the
 * exposed group is gaining or shedding workers decides whether a rising average
 * wage is evidence of anything at all.
 */
/** Latest observation month of a raw series, for panel vintage stamping. */
function latestDateOf(obs) {
  const s = sorted(obs);
  return s.length ? ymOf(s[s.length - 1].date) : null;
}

function exposedEmploymentYoY(series) {
  const maps = DIFFERENTIALS.jobs.exposed.map((id) => yoyByMonth(series[id]));
  const months = new Set();
  for (const m of maps) for (const k of m.keys()) months.add(k);
  const sorted = [...months].sort();
  for (let i = sorted.length - 1; i >= 0; i--) {
    const vals = maps.map((m) => m.get(sorted[i])).filter((v) => v != null);
    if (vals.length === maps.length) return vals.reduce((a, b) => a + b, 0) / vals.length;
  }
  return null;
}

/** [month, value] pairs for a raw FRED series, oldest first. */
const datedOf = (obs) => sorted(obs).map((o) => [ymOf(o.date), o.value]);

/** N-month change of a dated series, keyed by the later month. */
function changeOverMonths(dated, months) {
  const byMonth = new Map(dated);
  const out = [];
  for (const [m, v] of dated) {
    const prior = byMonth.get(ymAdd(m, -months));
    if (prior != null) out.push([m, v - prior]);
  }
  return out;
}

/** Month-by-month difference of two dated series, on their shared months. */
function spreadOf(datedA, datedB) {
  const b = new Map(datedB);
  return datedA.filter(([m]) => b.has(m)).map(([m, v]) => [m, v - b.get(m)]);
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

// --- The two baselines ------------------------------------------------------
//
// Every z on this dashboard is now reported TWICE: once against the fixed
// pre-treatment window (2010-2019) and once against everything we hold minus the
// unusable middle. Neither reading is the "real" one. The pre-2020 figure is the
// only clean control, but it is old and cannot know about structural changes that
// have nothing to do with AI; the full-history figure is current but includes the
// period under test in its own definition of normal. The gap between them is the
// measurement of how much the second problem matters, which is why both travel.
//
// Read the divergence like this: if the full-history z is materially SMALLER than
// the fixed-baseline z, the observation period has been pulling "normal" toward
// itself — the panel is being graded against its own recent behaviour.

const inBaseline = (ym) => ym >= BASELINE_START && ym <= BASELINE_END;
const inUnusable = (ym) => ym >= UNUSABLE_START && ym <= UNUSABLE_END;
const inObservation = (ym) => ym >= OBSERVATION_START;

/** Readings inside the fixed pre-treatment window, in order. */
const baselineSample = (dated) => dated.filter(([m]) => inBaseline(m));
/** Every reading except the unusable middle, latest excluded by the caller. */
const usableSample = (dated) => dated.filter(([m]) => !inUnusable(m));

function stats(vals) {
  if (!vals.length) return null;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
  return { mean, sd, n: vals.length };
}

/**
 * Does this sample actually COVER the baseline, starting when it is supposed to?
 *
 * This is the acceptance test, and it replaced a reading count because the count
 * was passing on windows that should never have qualified: 36 monthly readings is
 * satisfiable by 2016-07..2019-12 alone, which is the late-cycle top of one
 * expansion rather than a neutral decade. Slack absorbs quarter-end dating only.
 */
function baselineCovers(datedSample) {
  if (!datedSample.length) return false;
  return monthsBetween(BASELINE_REQUIRED_START, datedSample[0][0]) <= BASELINE_START_SLACK_MONTHS;
}

/**
 * z of [latest] against a dated sample. Returns null rather than a number computed
 * off an unrepresentative window — a baseline that starts late has to read as "no
 * clean baseline exists", never as a quiet fallback.
 */
function zAgainst(latest, datedSample, opts = {}) {
  const { requireCoverage = true, minReadings = BASELINE_MIN_READINGS } = opts;
  if (requireCoverage && !baselineCovers(datedSample)) return null;
  const st = stats(datedSample.map(([, v]) => v));
  if (!st || st.n < minReadings || st.sd < 1e-9) return null;
  return (latest - st.mean) / st.sd;
}

const stateForZ = (z) => (z == null ? "steady" : z >= BREAK_Z ? "break" : z >= WATCH_Z ? "watch" : "steady");

/**
 * The panel's trigger value in its own units, off the FIXED baseline (one-tailed
 * two sigma). Previously computed off the rolling window, which meant the alarm
 * line drifted with the data it was supposed to be judging.
 */
function twoSigmaTrigger(dated, upperSide) {
  const st = stats(baselineSample(dated).map(([, v]) => v));
  if (!st || st.n < BASELINE_MIN_READINGS || st.sd < 1e-9) return null;
  return upperSide ? st.mean + BREAK_Z * st.sd : st.mean - BREAK_Z * st.sd;
}

// --- Step 3: long-run context, deviation, and last month ----------------------
//
// The analyst gets MORE, not less. For every series: the current value and its
// date, enough history to know what normal looks like, the deviation from normal
// as a z-score where one is computed, the previous reading, and an explicit flag
// for what moved since the last analysis run.
//
// The wage series was the template for this: sending only "exposed pay growth is
// 4.6%" invites the model to invent context. Sending the same number alongside
// its own calm-period distribution lets it say whether 4.6 is remarkable.
//
// Still NOT included, deliberately: the mechanical stoplight's verdict labels.
// The analyst now owns its own verdict, and the rule-based lights have to be able
// to visibly disagree with it — which they cannot do if the analyst was shown the
// answer first.

/**
 * What normal looks like for this series: the calm-period (COVID-excluded)
 * distribution, plus its range and how many readings back it goes.
 * [dated] is [month, value] in the series' own units and orientation.
 */
function rangeOf(dated) {
  if (!dated.length) return {};
  let lo = dated[0], hi = dated[0];
  for (const p of dated) {
    if (p[1] < lo[1]) lo = p;
    if (p[1] > hi[1]) hi = p;
  }
  return {
    low: round2(lo[1]), low_date: lo[0],
    high: round2(hi[1]), high_date: hi[0],
  };
}

function longRun(dated, panelName = null) {
  const base = baselineSample(dated);
  const full = usableSample(dated);
  const bst = stats(base.map(([, v]) => v));
  const fst = stats(full.map(([, v]) => v));

  // Acceptance is COVERAGE FROM THE REQUIRED START, not a reading count. The count
  // was the original test and it was too weak to do the job: 36 monthly readings is
  // satisfiable by 2016-07..2019-12 alone, so a series could pass while its entire
  // "normal" was drawn from the late-cycle top of one expansion.
  const covers = baselineCovers(base);
  const enough = bst != null && bst.n >= BASELINE_MIN_READINGS;
  const exemptReason = panelName ? BASELINE_EXEMPT_PANELS[panelName] ?? null : null;

  const fixed = !covers || !enough
    ? {
        usable: false,
        readings: bst?.n ?? 0,
        actual_baseline_start: base.length ? base[0][0] : null,
        required_baseline_start: BASELINE_REQUIRED_START,
        // A declared reason where one exists, so "cannot reach the baseline" is
        // never indistinguishable from "something broke in the pull".
        reason: exemptReason ??
          (base.length
            ? `this series' baseline starts at ${base[0][0]}, later than the required ` +
              `${BASELINE_REQUIRED_START}, and no reason is on record for that`
            : `this series has no readings at all inside ${BASELINE_START} to ${BASELINE_END}`),
        note:
          `NO CLEAN PRE-2020 BASELINE. A window that starts late is not a smaller version ` +
          `of the right window, it is a different and unrepresentative one: the years most ` +
          `often left over are 2016-2019, the top of the last expansion, which makes almost ` +
          `anything today look weak by comparison. So no deviation figure is reported ` +
          `against the fixed window here. Read this panel on its levels and its direction, ` +
          `not on how unusual it is.`,
      }
    : {
        usable: true,
        mean: round2(bst.mean),
        standard_deviation: round2(bst.sd),
        ...rangeOf(base),
        readings: bst.n,
        window: `${base[0][0]} to ${base[base.length - 1][0]}, fixed and never rolling`,
        // Kept for the quarter-end case: a quarterly panel legitimately starts
        // 2010-03, and stating it is cheaper than leaving a reader to wonder.
        start_offset_note: base[0][0] !== BASELINE_START
          ? `baseline starts ${base[0][0]} rather than ${BASELINE_START}, within the ` +
            `${BASELINE_START_SLACK_MONTHS}-month allowance for quarter-end dating`
          : null,
      };

  return {
    fixed_pre2020_baseline: fixed,
    full_history: fst
      ? {
          mean: round2(fst.mean),
          standard_deviation: round2(fst.sd),
          ...rangeOf(full),
          readings: fst.n,
          window: `every reading from ${full[0][0]} onward with ${UNUSABLE_START} to ${UNUSABLE_END} excluded`,
          contamination_note:
            `This window CONTAINS the period under test (${OBSERVATION_START} onward), so it is not an ` +
            `independent control. It is reported so the two can be compared, not as the ` +
            `preferred reading.`,
        }
      : null,
  };
}

/**
 * Deviation from normal in standard deviations, on the same trailing window and
 * COVID exclusion the panels use. [oriented] is [month, value] with higher =
 * further toward displacement, so a positive number always means "more
 * displacement-shaped", whatever the underlying series' sign convention is.
 */
function deviation(oriented) {
  if (!oriented.length) return null;
  const latest = oriented[oriented.length - 1][1];
  // The fixed reading requires baseline coverage; the full-history reading does not,
  // because it makes no claim to be a clean control in the first place.
  const zFixed = zAgainst(latest, baselineSample(oriented));
  // Latest excluded from its own comparison window, as before.
  const zFull = zAgainst(latest, usableSample(oriented.slice(0, -1)), {
    requireCoverage: false, minReadings: WATCH_MIN_HISTORY,
  });
  if (zFixed == null && zFull == null) return null;

  // The divergence is the point of reporting both, so it is computed here rather
  // than left as arithmetic for the reader. Positive means the fixed baseline
  // reads MORE displacement-shaped than full history does, which is the
  // signature of full history having absorbed the trend.
  const divergence = zFixed != null && zFull != null ? zFixed - zFull : null;

  return {
    against_fixed_pre2020_baseline: zFixed == null ? null : round2(zFixed),
    against_full_history: zFull == null ? null : round2(zFull),
    divergence: divergence == null ? null : round2(divergence),
    divergence_note: divergence == null
      ? "only one of the two readings could be computed, so they cannot be compared. " +
        "If the fixed-baseline figure is the missing one, see this panel's " +
        "long_run_context for why it has no clean baseline"
      : Math.abs(divergence) < 0.25
        ? "the two baselines agree, so this reading does not depend on which window is used"
        : divergence > 0
          ? "this reading looks LESS unusual against full history than against the clean " +
            "pre-2020 window, which is what it looks like when the period under test has " +
            "been absorbed into the definition of normal. Prefer the pre-2020 figure."
          : "this reading looks MORE unusual against full history than against the clean " +
            "pre-2020 window, so the recent period is more extreme than the pre-2020 " +
            "record and the divergence is not a contamination artifact.",
    orientation: "positive means further toward displacement; negative means further away",
    alarm_line: BREAK_Z,
    attention_line: WATCH_Z,
    which_to_prefer:
      `The fixed ${BASELINE_START} to ${BASELINE_END} window is the only baseline that does not ` +
      `contain the period being judged. Where the two disagree, reason from it and say ` +
      `that you are doing so.`,
  };
}

/** The reading before the latest one, so a move can be read as a move. */
function priorReading(dated) {
  if (dated.length < 2) return null;
  const [date, value] = dated[dated.length - 2];
  return { value: round2(value), date };
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
  // The baseline is fixed, so every reading is scored against the SAME mean and
  // standard deviation. Under the old rolling window each reading was scored
  // against its own preceding decade, which meant a long streak was partly
  // measuring the window sliding rather than the series moving.
  const base = stats(baselineSample(oriented).map(([, v]) => v));
  if (!base || base.n < BASELINE_MIN_READINGS || base.sd < 1e-9) return null;

  // Walked over the observation period only. The unusable middle is not a
  // condition the panel "held", and readings inside the baseline are steady by
  // construction, so including either would inflate every streak.
  const walk = oriented.filter(([m]) => inObservation(m));
  if (!walk.length) return null;

  const states = walk.map(([m, v]) => [m, stateForZ((v - base.mean) / base.sd)]);
  const zs = walk.map(([, v]) => (v - base.mean) / base.sd);

  const current = states[states.length - 1][1];
  let consecutive = 0;
  let start = states[states.length - 1][0];
  for (let j = states.length - 1; j >= 0; j--) {
    if (states[j][1] === current) { consecutive++; start = states[j][0]; } else break;
  }
  const censored = consecutive === states.length; // ran to the start of the window
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
    ? "inside the range its own 2010s history defined"
    : current === "watch" ? "modestly past its alarm line" : "well past its alarm line";
  const noun = consecutive === 1 ? "reading" : "readings";
  const prefix = censored ? "at least " : "";
  const tail = censored
    ? ` — the streak reaches the start of the observation window (${OBSERVATION_START}), so it may be longer than this`
    : "";
  return `${prefix}${consecutive} consecutive ${cadence} ${noun} ${condition} (${elapsed(months)}), ${drift}${tail}`;
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
  const z = zAgainst(oriented[oriented.length - 1][1], baselineSample(oriented));
  return stateForZ(z);
}

/**
 * The fixed-baseline z of the latest reading, exported for the paired state.
 * Returns null when no clean baseline exists, and the caller must treat that as
 * "cannot place this axis" rather than as zero.
 */
export function fixedBaselineZ(oriented) {
  if (!oriented.length) return null;
  return zAgainst(oriented[oriented.length - 1][1], baselineSample(oriented));
}

// --- The reabsorption axis ---------------------------------------------------
//
// Everything here is measured as a 12-MONTH CHANGE rather than a level, and that
// is a deliberate statistical choice rather than a stylistic one. These are level
// series with strong decade-scale trends, and the fixed baseline opens in the
// post-financial-crisis hole: prime-age employment-population bottomed near 74.8
// in 2010-2011 and climbed for a decade, and the long-term-unemployed share was
// at a record high over the same stretch. Scoring today's LEVEL against the
// 2010-2019 mean would therefore read as "abnormally healthy" more or less
// permanently, and the deterioration side of this axis would be unfireable by
// construction. Scoring the CHANGE asks the question that actually matters — is
// absorption getting worse — and it is what Card 2 already does with the worker
// income share, for this same reason.

/**
 * One reabsorption component. [orientSign] is +1 when a RISING value means
 * deterioration and -1 when a FALLING value does, so every returned z is
 * deterioration-positive and the components can be read against one line.
 */
function reabsorptionComponent(seriesId, label, unit, dated, orientSign, meaning) {
  if (!dated.length) {
    return { series_id: seriesId, display_label: label, available: false, note: "series absent from the pool this run" };
  }
  const changes = changeOverMonths(dated, REABSORPTION_CHANGE_MONTHS);
  const oriented = changes.map(([m, v]) => [m, orientSign * v]);
  const fast = changeOverMonths(dated, REABSORPTION_FAST_CHANGE_MONTHS);
  const fastOriented = fast.map(([m, v]) => [m, orientSign * v]);
  const latest = dated[dated.length - 1];
  const latestChange = changes.length ? changes[changes.length - 1] : null;
  const latestFast = fast.length ? fast[fast.length - 1] : null;
  const dirOf = (v) => (v == null ? "unknown" : Math.abs(v) < 1e-9 ? "flat" : v > 0 ? "rising" : "falling");

  return {
    series_id: seriesId,
    display_label: label,
    unit,
    what_it_reads: meaning,
    latest_value: round2(latest[1]),
    latest_date: latest[0],
    change_over_12_months: latestChange ? round2(latestChange[1]) : null,
    direction: dirOf(latestChange?.[1]),
    deterioration_direction: orientSign > 0 ? "rising is deterioration" : "falling is deterioration",
    long_run_context_12m_changes: longRun(oriented),
    deviation_from_normal: deviation(oriented),
    // The fast horizon. A twelve-month change is the right orientation for placing
    // the axis and it is slow — a turn can take a year to appear in it — so the
    // three-month change is carried alongside to make a recent inflection visible
    // sooner. It is CONTEXT AND NOT A SECOND VOTE.
    fast_horizon: {
      months: REABSORPTION_FAST_CHANGE_MONTHS,
      change: latestFast ? round2(latestFast[1]) : null,
      direction: dirOf(latestFast?.[1]),
      deviation_from_normal: deviation(fastOriented),
      role:
        `CONTEXT ONLY. The ${REABSORPTION_CHANGE_MONTHS}-month change above places this axis; this ` +
        `${REABSORPTION_FAST_CHANGE_MONTHS}-month reading does not and must not be treated as a second ` +
        `vote. Use it to notice a turn earlier than the headline can show one, and to say ` +
        `whether the two horizons agree.`,
      reading_rule:
        `A ${REABSORPTION_FAST_CHANGE_MONTHS}-month change on a monthly series is noisy, and it is ` +
        `not seasonally comparable to the ${REABSORPTION_CHANGE_MONTHS}-month figure. If it disagrees with ` +
        `the headline, that is a hypothesis about a possible turn, not a finding. Say ` +
        `which horizon you are citing whenever you cite either.`,
      agrees_with_headline: latestFast && latestChange
        ? Math.sign(latestFast[1]) === Math.sign(latestChange[1])
        : null,
    },
  };
}

/**
 * The reabsorption axis: whether the outflow from AI-exposed work is landing.
 * Exported because BOTH the payload panel and the paired state read it, and they
 * must read the same numbers — the state is a check on the analyst's reasoning
 * over this panel, which is worthless if the two are computed differently.
 */
export function reabsorptionReadings(series) {
  const epop = datedOf(series[REABSORPTION.primeAgeEpop]);
  const ltu = datedOf(series[REABSORPTION.longTermUnemployedShare]);
  const hires = datedOf(series[REABSORPTION.hiresRate]);
  const quits = datedOf(series[REABSORPTION.quitsRate]);
  const u6 = datedOf(series[REABSORPTION.u6]);
  const u3 = datedOf(series[REABSORPTION.u3]);
  const netHiring = spreadOf(hires, quits);
  const underemployment = spreadOf(u6, u3);

  const headline = reabsorptionComponent(
    REABSORPTION.primeAgeEpop,
    "Share of 25-to-54-year-olds with a job",
    "percent of the 25-54 population",
    epop, -1,
    "THE HEADLINE. Restricted to 25-54 on purpose: the all-ages employment rate " +
    "falls when people retire, which has nothing to do with anyone being displaced. " +
    "If work is being destroyed rather than moved, this is where it has to show up.",
  );

  const refVals = epop.filter(([m]) => m.startsWith(`${REABSORPTION_REFERENCE_YEAR}-`)).map(([, v]) => v);
  const reference = refVals.length ? refVals.reduce((a, b) => a + b, 0) / refVals.length : null;
  const latestLevel = epop.length ? epop[epop.length - 1][1] : null;
  const shortfall = reference != null && latestLevel != null ? reference - latestLevel : null;

  return {
    headline,
    // The axis is placed on the LEVEL against a fixed reference year, not on the z
    // of a 12-month change. The change version scored a mature expansion against a
    // decade of post-2008 recovery, so it read deterioration that was mostly the
    // recovery having ended. See REABSORPTION_REFERENCE_YEAR in config.
    reference,
    shortfall,
    secondary: [
      reabsorptionComponent(
        REABSORPTION.longTermUnemployedShare,
        "Share of the unemployed who have been out 27 weeks or more",
        "percent of the unemployed", ltu, +1,
        "Whether the people leaving are failing to land. Short spells mean a working " +
        "labour market; a rising long-term share means exits are not being caught.",
      ),
      {
        // Built through the shared helper so the spread gets the same dual-horizon
        // treatment as every other component, then annotated with both legs: a net
        // figure alone hides whether hiring fell or quitting rose.
        ...reabsorptionComponent(
          `${REABSORPTION.hiresRate} minus ${REABSORPTION.quitsRate}`,
          "Hiring pace against quitting pace",
          "rate points (percent of employment, per month)",
          netHiring, -1,
          "Absorption against shedding. Hires above quits means the market is taking " +
          "on more people than are voluntarily leaving.",
        ),
        hires_rate: hires.length ? round2(hires[hires.length - 1][1]) : null,
        quits_rate: quits.length ? round2(quits[quits.length - 1][1]) : null,
        both_sides_note:
          "Name the moving side here too: this net figure falls both when hiring slows " +
          "and when quitting accelerates, and those are different stories. The two " +
          "underlying rates are given above.",
      },
      reabsorptionComponent(
        `${REABSORPTION.u6} minus ${REABSORPTION.u3}`,
        "Underemployment gap (U-6 minus U-3)",
        "percentage points",
        underemployment, +1,
        "Whether people are landing but landing badly — part-time for economic " +
        "reasons, or discouraged out of the count entirely. A displacement episode " +
        "absorbed into worse work would widen this while the headline job count held.",
      ),
    ],
    componentVintages: {
      [REABSORPTION.primeAgeEpop]: epop.length ? epop[epop.length - 1][0] : null,
      [REABSORPTION.longTermUnemployedShare]: ltu.length ? ltu[ltu.length - 1][0] : null,
      [REABSORPTION.hiresRate]: hires.length ? hires[hires.length - 1][0] : null,
      [REABSORPTION.quitsRate]: quits.length ? quits[quits.length - 1][0] : null,
      [REABSORPTION.u6]: u6.length ? u6[u6.length - 1][0] : null,
    },
  };
}

// The two axes of the paired state, exposed as deterioration-oriented series so
// the state module can place them without re-deriving anything. Note what is NOT
// here: this file computes no paired state and imports nothing that does. The
// payload is what the model sees, so the boundary is enforced by the direction of
// the dependency rather than by remembering to leave a field out.
export function attributionAxisOriented(pool) {
  const series = pool.fred.series ?? {};
  return avgYoyDiffSeries(DIFFERENTIALS.jobs.exposed, DIFFERENTIALS.jobs.control, series)
    .map((p) => [p.month, -p.diff]); // gap widening = positive
}

/**
 * The reference level: the mean of the reference year. A calendar-year mean rather
 * than a single-month peak, because one month is noisy and a peak is by definition
 * the least representative month available.
 */
export function reabsorptionReference(pool) {
  const epop = datedOf((pool.fred.series ?? {})[REABSORPTION.primeAgeEpop]);
  const yr = String(REABSORPTION_REFERENCE_YEAR);
  const vals = epop.filter(([m]) => m.startsWith(`${yr}-`)).map(([, v]) => v);
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/**
 * Deterioration-positive shortfall against the reference: POINTS BELOW 2019.
 * Positive means fewer prime-age people are working than in 2019.
 *
 * A level, not a change. See REABSORPTION_REFERENCE_YEAR in config for why the
 * change version was retired: the 2010-2019 baseline of changes is a decade of
 * recovery, so any mature-expansion year scored as deteriorating against it.
 */
export function reabsorptionAxisOriented(pool) {
  const series = pool.fred.series ?? {};
  const epop = datedOf(series[REABSORPTION.primeAgeEpop]);
  // Deterioration-positive 12-month CHANGE: falling employment share = positive.
  // Compared against RAW ZERO, so there is no baseline, no reference year and no
  // threshold. "Is the share of prime-age people working rising or falling" is a
  // question with a natural zero and no parameters.
  return changeOverMonths(epop, REABSORPTION_CHANGE_MONTHS).map(([m, v]) => [m, -v]);
}

/**
 * Why a ratio moved: employment, or population?
 *
 * The headline is employed/population, so it can fall two ways, and they mean
 * opposite things. Employment falling is people losing work. Population growing
 * faster than employment is a larger working-age population the job market has not
 * absorbed yet, which is usually immigration or a big cohort ageing in. Reported
 * rather than resolved: the analyst decides what it means.
 */
export function reabsorptionDecomposition(pool) {
  const series = pool.fred.series ?? {};
  const emp = datedOf(series[REABSORPTION.primeAgeEmployed]);
  const pop = datedOf(series[REABSORPTION.primeAgePopulation]);
  if (!emp.length || !pop.length) return null;
  const empChg = changeOverMonths(emp, REABSORPTION_CHANGE_MONTHS);
  const popChg = changeOverMonths(pop, REABSORPTION_CHANGE_MONTHS);
  const e = empChg.length ? empChg[empChg.length - 1] : null;
  const p = popChg.length ? popChg[popChg.length - 1] : null;
  if (!e || !p) return null;
  const empPct = emp.length ? (e[1] / emp[emp.length - 1][1]) * 100 : null;
  const popPct = pop.length ? (p[1] / pop[pop.length - 1][1]) * 100 : null;
  return {
    as_of: e[0],
    employed_change_thousands: Math.round(e[1]),
    population_change_thousands: Math.round(p[1]),
    employed_change_percent: round2(empPct),
    population_change_percent: round2(popPct),
    // The whole point of sending this.
    reading: e[1] < 0
      ? "The employment share fell with employment ITSELF falling: fewer prime-age people are working than a year ago."
      : popPct != null && empPct != null && popPct > empPct
        ? "The employment share fell WITHOUT employment falling: more prime-age people are here, and the job market has not absorbed the increase. That is a different claim from people losing work."
        : "Employment grew at least as fast as the prime-age population.",
    caveat:
      "Employment is seasonally adjusted and population is not, so do not subtract " +
      "one from the other and expect the ratio's change exactly; read the two " +
      "directions rather than the arithmetic.",
  };
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

// --- Step 3, item 5: what changed since the last analysis run ----------------
//
// Each run stores a compact headline value per panel in its dissent-log entry;
// the next run diffs against it. Without this the model has to infer "what's
// new" from the numbers alone, which is exactly the kind of inference that
// invents movement — and the spec asks for the news value to LEAD, so what
// changed has to be a fact in the payload, not a guess.

/** The one number per panel that a reader would notice moving. */
const HEADLINE_FIELDS = [
  "differential_exposed_minus_control",
  "spread_exposed_minus_control",
  "change_over_4_quarters",
  "automation_value",
  "yield_curve_10yr_minus_2yr",
  "latest_value",
];

function headlineOf(panel) {
  if (panel.panel === "ai_capability_gdpval_ratings") {
    return { value: panel.top_matchup?.elo_a ?? null, date: panel.as_of ?? null };
  }
  if (panel.panel === "ai_capability_metr") {
    const top = panel.top_models_by_80pct_horizon?.[0];
    return { value: top?.horizon_80pct_minutes ?? null, date: top?.model ?? null };
  }
  for (const f of HEADLINE_FIELDS) {
    if (panel[f] != null) return { value: panel[f], date: panel.latest_date ?? null };
  }
  return { value: null, date: panel.latest_date ?? null };
}

/** Stored in each run's log entry so the next run can diff against it. */
export function panelHeadlines(panels) {
  const out = {};
  for (const p of panels) out[p.panel] = headlineOf(p);
  return out;
}

/**
 * Explicit what-changed block. [prior] is a previous run's panelHeadlines output.
 * With no prior run this says so — never silently implies "nothing changed".
 */
export function changesSinceLastRun(panels, prior, priorRunAt, priorDataMonth) {
  if (!prior) {
    return {
      previous_run: null,
      note: "this is the first run under the current analysis format, so there is no previous run to compare against; do not describe anything as new or unchanged on this basis",
    };
  }
  const moved = [];
  const unchanged = [];
  const isNew = [];
  for (const p of panels) {
    const now = headlineOf(p);
    const was = prior[p.panel];
    if (!was) { isNew.push(p.panel); continue; }
    const valueMoved = was.value != null && now.value != null && round2(was.value) !== round2(now.value);
    const dateMoved = was.date != null && now.date != null && was.date !== now.date;
    if (valueMoved || dateMoved) {
      moved.push({
        panel: p.panel,
        display_label: p.display_label,
        was: was.value, now: now.value,
        change: was.value != null && now.value != null ? round2(now.value - was.value) : null,
        reading_date_was: was.date, reading_date_now: now.date,
      });
    } else {
      unchanged.push(p.panel);
    }
  }
  return {
    previous_run: priorRunAt ?? null,
    previous_data_month: priorDataMonth ?? null,
    panels_that_moved: moved,
    panels_unchanged: unchanged,
    panels_new_to_the_dashboard: isNew,
    note: moved.length === 0
      ? "no panel's headline number moved since the last run; say so plainly rather than manufacturing a development"
      : "these are the only panels whose headline number moved since the last run; anything else has not changed",
  };
}

/**
 * Panel vintages span roughly ten months on this dashboard, and until now that was
 * stated nowhere: the income share is a quarter behind the labor panels, postings
 * and adoption are ahead of them, and the usage split is most of a year old. Every
 * panel therefore carries an explicit as_of, and anything more than
 * STALE_PANEL_MONTHS old is flagged so the analyst discounts it rather than
 * treating it as current.
 */
const STALE_PANEL_MONTHS = 6;

/**
 * Adoption by firm-employment-size class, as whatever bands the snapshot carries.
 * Written to pass through every band present rather than naming two, so extending
 * the extractor to the survey's full A-G set needs no change here.
 */
function adoptionBySize(bySize) {
  if (!bySize) return null;
  const bands = [];
  for (const key of ["smallest", "small", "mid", "large", "larger", "largest"]) {
    const b = bySize[key];
    if (!b?.points?.length) continue;
    const pts = b.points;
    const latest = pts[pts.length - 1];
    const first = pts[0];
    bands.push({
      band: b.label ?? key,
      latest_percent: round1(latest.pct),
      latest_date: String(latest.date).slice(0, 7),
      first_percent: round1(first.pct),
      first_date: String(first.date).slice(0, 7),
      readings: pts.length,
    });
  }
  if (bands.length === 0) return null;
  const lo = bands[0];
  const hi = bands[bands.length - 1];
  return {
    bands,
    gradient_largest_over_smallest:
      lo.latest_percent > 0 ? round2(hi.latest_percent / lo.latest_percent) : null,
    gradient_note:
      `Largest band ${hi.latest_percent} percent of firms against smallest band ` +
      `${lo.latest_percent} percent. Adoption rises with employer size, so the share of ` +
      `WORKERS at an AI-using employer is higher than the headline firm share.`,
    bands_available: bands.length,
    bands_caveat: bands.length < 3
      ? "Only the extreme bands are extracted from the source at present; the survey " +
        "publishes more. Read the gradient as a direction, not as a distribution."
      : null,
  };
}

function monthsBetween(ymA, ymB) {
  const [ay, am] = ymA.split("-").map(Number);
  const [by, bm] = ymB.split("-").map(Number);
  return (by * 12 + bm) - (ay * 12 + am);
}

/**
 * Attach as_of (and a staleness flag) to every panel, derived from whatever date
 * field that panel already carries. Done as a pass over the finished list so a new
 * panel gets a vintage automatically rather than by remembering to add one.
 */
function attachVintage(panels, todayYm) {
  for (const p of panels) {
    const explicit = p.as_of ?? null;
    const fromLatest = p.latest_date ?? null;
    const fromSeries = (() => {
      const s = p.full_series ?? p.rows ?? null;
      if (!Array.isArray(s) || s.length === 0) return null;
      const last = s[s.length - 1];
      return last.date ?? last.released ?? null;
    })();
    const raw = explicit ?? fromLatest ?? fromSeries;
    const ym = raw ? String(raw).slice(0, 7) : null;
    p.as_of = ym;
    if (ym) {
      const age = monthsBetween(ym, todayYm);
      p.as_of_months_old = age;
      if (age > STALE_PANEL_MONTHS) {
        p.stale = true;
        p.stale_note =
          `This reading is ${age} months old (${ym}). Treat it as historical context, ` +
          `not as a current measurement, and do not compare it to this month's panels ` +
          `without saying that it predates them.`;
      }
    }
  }
  return panels;
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
    const dated = s.map((o) => [quarterEndMonth(o.date), o.value]);
    panels.push({
      panel: "labor_productivity",
      series_id: "PRS85006091",
      display_label: "Labor productivity, output per hour",
      unit: "percent (change from a year earlier)",
      latest_value: round1(last?.value),
      latest_date: last ? quarterEndMonth(last.date) : null,
      prior_reading: priorReading(dated),
      long_run_context: longRun(dated),
      // Judged against the registered band, not a z-score — so no deviation block
      // here. The band IS this panel's normal (2.7 to 3.4 is the internet-boom pace).
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
      // Demoted 2026-07-26. This panel establishes that something is specific to
      // AI-exposed work. It does not establish displacement, and it used to be
      // read as though it did.
      panel_role: "ATTRIBUTION",
      panel_role_note:
        "This is the attribution half of the question, not the verdict. It is the only " +
        "measure on the dashboard that can separate an AI-specific story from a general " +
        "economic one, which is why it is necessary. It cannot say whether work was " +
        "destroyed. Pair it with the reabsorption panel before concluding anything.",
      unit: "percent (year-over-year job growth)",
      exposed_value: round1(last?.exposed),
      control_value: round1(last?.control),
      differential_exposed_minus_control: round1(last?.diff),
      latest_date: last?.month ?? null,
      prior_reading: priorReading(pts.map((p) => [p.month, p.diff])),
      // A fact about what this instrument can and cannot see, carried with every
      // reading rather than left in a rule the model may or may not apply here.
      measurement_artifact: {
        text:
          "This measures REALLOCATION, not destruction. Work the mechanics: if AI " +
          "eliminates 100 jobs in information and professional services and all 100 of " +
          "those workers are hired in construction and health care, exposed employment " +
          "falls, control employment rises, the gap widens from both ends at once, and " +
          "total employment is unchanged with every worker landing somewhere. Perfect " +
          "reallocation with nobody left behind produces the MAXIMALLY negative reading " +
          "on this panel. A widening gap is therefore consistent with mass displacement " +
          "and with entirely benign job-switching, and this panel cannot tell them apart.",
        weighting_rule:
          "Never treat a widening gap as displacement on its own. Read it as: something " +
          "is happening specifically to AI-exposed work. Then go to the reabsorption " +
          "panel to find out whether the outflow landed. If the gap is widening while " +
          "prime-age employment, long-term unemployment and hiring hold steady, workers " +
          "are moving rather than being removed.",
        industry_proxy_caveat:
          "Exposure here is assigned by INDUSTRY, which is a crude proxy for exposure to " +
          "AI. A janitor employed in the information sector counts as exposed; a data " +
          "analyst employed in manufacturing does not. Occupation-level task exposure " +
          "would be the better frame, but occupational data is annual and heavily lagged, " +
          "so this trades accuracy for responsiveness. Do not attribute precision to the " +
          "exposed/control split that the industry proxy cannot support.",
      },
      long_run_context: longRun(pts.map((p) => [p.month, p.diff])),
      deviation_from_normal: deviation(pts.map((p) => [p.month, -p.diff])),
      streak: streakString(pts.map((p) => [p.month, -p.diff]), "monthly"),
      threshold: { differential_trigger: round1(trigger), rule: `the attribution line is the exposed-minus-control gap falling two standard deviations below its ${BASELINE_START} to ${BASELINE_END} average (a wide but steady gap is not the signal; the gap widening is). Crossing it means AI-exposed work is diverging, not that anyone was displaced` },
    });
  }

  // --- Reabsorption: did the outflow land anywhere? (the other half) ---
  {
    const r = reabsorptionReadings(series);
    const vintages = Object.entries(r.componentVintages).filter(([, v]) => v);
    const dates = vintages.map(([, v]) => v).sort();
    panels.push({
      panel: "reabsorption",
      as_of: r.headline.latest_date ?? null,
      series_id: Object.values(REABSORPTION).join(", "),
      display_label: "Are people who left finding work",
      panel_role: "REABSORPTION",
      panel_role_note:
        "The other half of the attribution panel. Displacement means work was removed " +
        "from the economy; reallocation means it moved. Only the aggregate labour market " +
        "can tell those apart, because a worker who left an exposed industry and was " +
        "hired in a control one is invisible to the exposed-vs-control gap but visible " +
        "here. None of these series requires knowing where any individual went.",
      unit: "see each component",
      headline: {
        ...r.headline,
        // What the axis is actually placed on, stated on the panel rather than
        // left implicit. A level against a named year, in points, which a reader
        // can check against their own sense of 2019.
        reference_year: REABSORPTION_REFERENCE_YEAR,
        reference_level: r.reference == null ? null : round2(r.reference),
        points_below_reference: r.shortfall == null ? null : round2(r.shortfall),
        level_reading: r.shortfall == null ? "no reference available"
          : r.shortfall > 0
            ? `${round2(r.shortfall)} points BELOW its ${REABSORPTION_REFERENCE_YEAR} level`
            : `${round2(-r.shortfall)} points ABOVE its ${REABSORPTION_REFERENCE_YEAR} level`,
        why_a_level_and_not_a_change:
          `The level is compared with a fixed ${REABSORPTION_REFERENCE_YEAR} reference rather than scored as a ` +
          `12-month change, because prime-age employment rose about 0.53 points a year ` +
          `across 2010-2019 while the economy recovered from the financial crisis. ` +
          `Against that decade, strongly positive changes were normal, so any ordinary ` +
          `expansion year would score as deteriorating for reasons having nothing to do ` +
          `with absorption. The trade-off is that a level is slow to register a fresh ` +
          `turn from a high starting point, which is why the 12-month and 3-month ` +
          `changes are reported beside it. Read the level for where things stand and the ` +
          `changes for which way they are moving; they can legitimately disagree.`,
      },
      secondary_readouts: r.secondary,
      reading_rule:
        "The HEADLINE places this axis, on its 12-month change. The three secondary " +
        "readouts are context and do not decide it on their own. This mirrors the rest of " +
        "the dashboard, where supplemental panels inform but do not vote, and it avoids an " +
        "unregistered composite index built out of four series with different vintages. " +
        "Every component also carries a 3-month fast_horizon, which is context for the " +
        "same reason and at one further remove: it exists to reveal a turn sooner than a " +
        "12-month change can, and a 3-month move on a noisy monthly series is precisely " +
        "what should not be able to move a verdict by itself. Where the two horizons " +
        "disagree, say so and say which one you are citing.",
      measurement_basis:
        `Every component here is scored as a ${REABSORPTION_CHANGE_MONTHS}-month CHANGE, not as a level. ` +
        `These are trending level series and the fixed baseline opens in the ` +
        `post-financial-crisis hole, so a level scored against the 2010s mean would read ` +
        `as abnormally healthy almost permanently and could never register deterioration. ` +
        `The question is whether absorption is getting worse, which is a question about change.`,
      component_vintages: r.componentVintages,
      vintage_note: dates.length > 1 && dates[0] !== dates[dates.length - 1]
        ? `These components do not share a vintage: the survey-based series run to ` +
          `${dates[dates.length - 1]} while the job-openings series run to ${dates[0]}. ` +
          `The headline is the fresher of the two, so a very recent turn would appear in ` +
          `the headline before the hiring and quitting figures caught up.`
        : null,
      threshold: {
        rule:
          `deterioration is the headline's 12-month change reaching ${WATCH_Z} standard deviations ` +
          `below its ${BASELINE_START} to ${BASELINE_END} norm. This panel does not fire an alarm by ` +
          `itself either: a weak aggregate with no exposed-industry divergence is an ordinary ` +
          `downturn, not an AI one.`,
      },
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
      prior_reading: priorReading(pts.map((p) => [p.month, p.diff])),
      // A fact about the instrument, not a competing explanation, so it travels
      // with every reading rather than being left for the model to rediscover.
      // The weighting rule needs the sign of exposed EMPLOYMENT change, so that
      // number is supplied here rather than requiring a cross-panel lookup.
      measurement_artifact: {
        text:
          "This compares AVERAGE pay across a changing group of workers. When employment in a " +
          "group is falling, the average can rise simply because lower-paid workers left, with " +
          "nobody receiving a raise. Average hourly earnings jumped sharply in April 2020 for " +
          "exactly this reason. The control group includes leisure and hospitality, which is " +
          "low-wage and growing, pushing the control average down for the same mechanical reason.",
        weighting_rule:
          "Weight this panel by the sign of exposed employment change. If exposed employment is " +
          "RISING, the composition story cannot explain rising pay and this is clean evidence. If " +
          "exposed employment is FALLING, this panel cannot distinguish augmentation from " +
          "displacement and must not be cited as strong support for either.",
        exposed_employment_yoy_percent: round2(exposedEmploymentYoY(series)),
        exposed_employment_direction:
          exposedEmploymentYoY(series) == null ? "unknown"
            : exposedEmploymentYoY(series) > 0 ? "rising" : "falling",
      },
      // The template for the whole "send long-run context" rule: real pay growth
      // has been weak for a long stretch AND the latest move may or may not be
      // sharp against that history. Those are two different facts; send both.
      long_run_context: longRun(pts.map((p) => [p.month, p.diff])),
      deviation_from_normal: deviation(pts.map((p) => [p.month, -p.diff])),
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
      unit: "index points, each side against its OWN February 2020 level = 100",
      // Both sides are sent as levels, not just the spread, and the baseline is
      // stated per side: a spread of -28 is a very different fact when exposed
      // sits a quarter below its pre-pandemic level while control sits above its own.
      exposed_value: last ? round1(last.exposed) : null,
      exposed_vs_own_prepandemic_baseline: last ? round1(last.exposed - 100) : null,
      control_value: last ? round1(last.control) : null,
      control_vs_own_prepandemic_baseline: last ? round1(last.control - 100) : null,
      spread_exposed_minus_control: last ? Math.round(last.spread) : null,
      spread_change_over_6_months: last && pp.length > 6 ? Math.round(last.spread - pp[pp.length - 7].spread) : null,
      latest_date: last ? last.date.slice(0, 7) : null,
      prior_reading: priorReading(pp.map((p) => [p.date.slice(0, 7), p.spread])),
      long_run_context: longRun(pp.map((p) => [p.date.slice(0, 7), p.spread]), "job_postings_spread"),
      deviation_from_normal: deviation(pp.map((p) => [p.date.slice(0, 7), -p.spread])),
      history_caveat: "this series begins February 2020, so it has no pre-pandemic baseline and a shorter calm history than the other panels",
      streak: streakString(pp.map((p) => [p.date.slice(0, 7), -p.spread]), "monthly"),
      threshold: { spread_trigger: trigger == null ? null : Math.round(trigger), rule: "postings lead hiring, so a spread two standard deviations below its calm-period average is an early version of the jobs alarm" },
    });
  }

  // --- Worker share of income (Card 2) ---
  //
  // NO THRESHOLD. RE-REGISTERED 2026-07-27, and the alarm is deleted rather than
  // retuned.
  //
  // The old rule scored the 4-quarter change against a 2-sigma trigger. It could
  // not mean what an alarm implies. This series has fallen for more than forty
  // years, from 58.7 percent in 1970 to 51.0 now, for reasons that predate AI by
  // decades: globalisation, union decline, capital deepening, the shift to
  // intangibles. Against that, "falling faster than usual" is a statement about
  // the business cycle, not about AI. Ordinary recessions have already produced
  // 4-quarter declines of -2.18 (2009-12) and -1.59 (2010-03), both past the -1.4
  // the trigger was set at, so the alarm fired on recessions and could never
  // discriminate. Two independent analyst runs then chose this panel for their
  // falsifier precisely BECAUSE it was the only one with clean history, and both
  // had to bolt a "control industries still growing" condition onto it to stop it
  // firing on a downturn. The threshold was doing harm.
  //
  // What replaces it is description with no verdict attached: where the level sits
  // in its own record, how fast it has drifted over several EXPLICIT fixed
  // horizons, and where the current 4-quarter change falls in the distribution of
  // all such changes. The analyst reads it and decides what it is worth.
  //
  // Deliberately NOT a fitted trend line. The audit retired one on this panel
  // (finding 1) because its reading depended on the fit window, and re-introducing
  // one under the name "deviation from trend" would repeat that mistake with
  // better manners. Several stated horizons cannot hide a window choice: they show
  // it.
  {
    const share = laborShareSeries(series);
    const last = share.length ? share[share.length - 1] : null;
    const changes = [];
    for (let i = LABOR_SHARE_CHANGE_QUARTERS; i < share.length; i++) {
      changes.push([quarterEndMonth(share[i].date), share[i].value - share[i - LABOR_SHARE_CHANGE_QUARTERS].value]);
    }
    const latestChange = changes.length ? changes[changes.length - 1][1] : null;
    const decl = declineStreakQuarters(share);

    // Drift over fixed look-backs, in quarters. Every horizon is named, so the
    // reader can see that a "fast" recent decline against a slow secular one is a
    // different claim from a fast one against a fast one.
    const driftOver = (quarters) => {
      if (share.length <= quarters) return null;
      const a = share[share.length - 1 - quarters];
      const b = share[share.length - 1];
      return {
        from_date: quarterEndMonth(a.date),
        from_value: round1(a.value),
        change: round2(b.value - a.value),
        change_per_year: round2((b.value - a.value) / (quarters / 4)),
      };
    };

    // Where the current 4-quarter change sits among ALL such changes on record.
    // A percentile, not a threshold: it says how ordinary the move is without
    // asserting that any particular rank means anything.
    const changeVals = changes.map(([, v]) => v);
    const rank = latestChange == null ? null
      : changeVals.filter((v) => v < latestChange).length;
    const percentile = rank == null || changeVals.length === 0 ? null
      : Math.round((rank / changeVals.length) * 100);
    panels.push({
      panel: "worker_share_of_income",
      series_id: "GDICOMP/GDI",
      display_label: "Worker share of national income",
      unit: "percent (of gross domestic income)",
      latest_value: round1(last?.value),
      latest_date: last ? quarterEndMonth(last.date) : null,
      change_over_4_quarters: round1(latestChange),
      prior_reading: priorReading(share.map((p) => [quarterEndMonth(p.date), p.value])),
      // Two different "normals" matter here, so both are sent: the level's own
      // 79-year range (the level is at a record low) and the distribution of
      // 4-quarter CHANGES (which is what the rule actually tests).
      long_run_context_level: longRun(share.map((p) => [quarterEndMonth(p.date), p.value])),
      long_run_context_4q_changes: longRun(changes),
      // NO deviation_from_normal block here, and its absence is deliberate: that
      // block carries an alarm_line and an attention_line, which is the thing this
      // panel is no longer entitled to.
      streak: last ? `${decl} consecutive quarterly ${decl === 1 ? "decline" : "declines"}` : null,
      trend_context: {
        drift_over_1_year: driftOver(4),
        drift_over_5_years: driftOver(20),
        drift_over_10_years: driftOver(40),
        drift_over_20_years: driftOver(80),
        drift_over_40_years: driftOver(160),
        // Named for what it counts rather than as a bare "percentile", which is
        // ambiguous about direction and easy to state backwards.
        percent_of_past_changes_that_fell_faster: percentile,
        percentile_note: percentile == null ? null
          : `Of every ${LABOR_SHARE_CHANGE_QUARTERS}-quarter change on record, ${percentile} percent fell FASTER ` +
            `than the current one, so the current one is in the fastest ${percentile} percent ` +
            `of declines this series has produced. This is a rank, not a threshold: no ` +
            `rank here is registered as meaning anything, and it is given so you can say ` +
            `whether a move is ordinary rather than so you can call it an alarm.`,
        how_to_read:
          "Compare the recent horizons against the long ones. A one-year decline that " +
          "matches the forty-year pace is the secular drift continuing. A one-year " +
          "decline several times the forty-year pace is something else, though not " +
          "necessarily something AI did.",
      },
      threshold: {
        rule:
          "NO THRESHOLD. This panel has no alarm line, no trigger and no deviation score, " +
          "and that is a deliberate re-registration rather than missing data. The share " +
          "has declined for more than forty years for reasons that predate AI, so " +
          `"falling faster than usual" is a business-cycle statement rather than an ` +
          "AI one: ordinary recessions produced 4-quarter falls of -2.18 in 2009 and " +
          "-1.59 in 2010, faster than anything AI has yet been accused of. Any trigger " +
          "set here fires on recessions. Read the level, the streak and the drift " +
          "horizons, say what you think they mean, and do not treat the absence of a " +
          "threshold as either reassurance or alarm.",
        population_caveat:
          "This is ECONOMY-WIDE. It covers every industry, so it cannot be evidence " +
          "about AI-exposed work specifically, whatever it does.",
      },
    });
  }

  // --- Recent-grad unemployment gap (supplemental) ---
  {
    const g = extras.inversion ?? null;
    panels.push({
      panel: "recent_grad_gap",
      as_of: latestDateOf(series.CGBD2024),
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
      prior_reading: priorReading(ap.map((p) => [p.date.slice(0, 7), p.pct])),
      full_series: ap.map((p) => ({ date: p.date.slice(0, 7), value: round1(p.pct) })),
      // The size-class cut. Previously the artifact told the analyst to check
      // whether adoption concentrates in large employers and the series was not
      // sent, so it correctly reported it could not do the check. An instruction to
      // check something absent is worse than no instruction.
      by_firm_size: adoptionBySize(extras.adoptionBySize),
      by_firm_size_note:
        "Share of firms using AI, split by employment-size class. This is the only cut " +
        "that speaks to WORKER exposure: a firm-count share treats a four-person shop and " +
        "a twenty-thousand-person employer as one vote each, so the headline understates " +
        "how many people work somewhere that uses AI whenever adoption rises with size. " +
        "It does rise with size here, and the gradient below is the measure of it.",
      employment_weighted_adoption:
        "NOT AVAILABLE. The survey publishes adoption by firm-size class but no " +
        "employment weights, and the establishment counts that would supply them come " +
        "from a different survey on a different unit (establishments, not firms), so " +
        "combining them would be a cross-source estimate rather than a measurement. " +
        "Reason from the size gradient instead, and do not state a worker-weighted " +
        "percentage as if it were measured.",
      history_caveat: "this is the whole series: the survey only retains a handful of months for the AI question, so it is a level-and-direction reading, not a long history",
      measurement_artifact: {
        text:
          "This is a share of SURVEYED FIRMS, counted one firm one vote, over a respondent panel " +
          "that rotates between collections. A move in the share can therefore come from a change " +
          "in who answered rather than a change in who adopted. It also counts firms, not workers: " +
          "the same percentage means something very different if the adopters are large employers.",
        weighting_rule:
          "Treat small month-to-month moves as noise and read the direction over several " +
          "collections. The size-class series below is the check: if adoption is concentrated in " +
          "the largest firms, headcount exposure is far higher than the headline share implies.",
      },
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
      full_series: aei.map((p) => ({
        date: p.date, automation: round1(p.automatePct), augmentation: round1(p.augmentPct),
      })),
      history_caveat: "one reading per dataset release, not a monthly series; the split has been close to stable across releases",
      // Flagged explicitly rather than left to the vintage pass: this is the
      // fastest-moving variable on the dashboard and the most out of date, which is
      // the worst combination and easy to miss.
      staleness_warning:
        "This is the STALEST panel here and it measures the fastest-moving thing on the " +
        "dashboard. The reading predates the current labor months by most of a year, so it " +
        "cannot describe how AI is being used now. Give it no weight in a current call " +
        "beyond noting that the split was stable over the releases that exist.",
      measurement_artifact: {
        text:
          "This is a share of SAMPLED CONVERSATIONS over a user base that changes between " +
          "releases. If the mix of people using the product shifts, the augmentation share moves " +
          "without any individual changing how they work. It measures one vendor's usage, not " +
          "the economy's, and conversations are not jobs.",
        weighting_rule:
          "Read this as weak directional context on how AI is being used, never as a measure of " +
          "how much work is being automated. A move here is only meaningful if it is large and " +
          "sustained across several releases.",
      },
      threshold: { rule: "a slow research series; a rising automation share only raises the displacement reading when adoption is also rising and exposed work is weakening" },
    });
  }

  // --- Macro regime gate ---
  {
    const macro = extras.macro ?? {};
    panels.push({
      panel: "macro_regime",
      as_of: latestDateOf(series.T10Y2Y),
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
      as_of: (() => {
        const ds = (extras.metrRecords ?? []).map((r) => r.releaseDate).filter(Boolean).sort();
        return ds.length ? String(ds[ds.length - 1]).slice(0, 7) : null;
      })(),
      series_id: "METR task-completion time horizons of frontier AI models",
      display_label: "AI capability: task-length horizon",
      unit: "minutes of human working time",
      top_models_by_80pct_horizon: top.map((m) => ({
        model: m.model, lab: m.lab,
        horizon_80pct_minutes: m.p80Min == null ? null : Math.round(m.p80Min),
        horizon_50pct_minutes: m.p50Min == null ? null : Math.round(m.p50Min),
      })),
      threshold: { rule: "descriptive context only. The 80 percent horizon is the level where a task can be handed off rather than checked. This was a capability gate until July 2026 and no longer conditions anything: a benchmark of clean, self-contained software tasks should not decide whether a real labor signal counts" },
      caveat: "the tasks are clean, self-contained, auto-scorable software, machine-learning and cyber problems, not the messy parts of a job; the human baselines are contractors working without prior context; and horizons past roughly 16 hours are beyond what the task suite can measure reliably",
    });
  }

  // --- AI capability: GDPval (model vs model, and model vs expert) ---
  // Both descriptive. Sent because "can the models do the work" is context the
  // labor read needs, not because either can move a verdict.
  {
    const board = extras.gdpval?.leaderboard ?? null;
    const records = [...(board?.records ?? [])].sort((a, b) => b.elo - a.elo);
    const family = (m) => String(m ?? "").replace(/\s*\([^()]*\)\s*$/, "").trim();
    const first = records[0] ?? null;
    const second = first ? (records.slice(1).find((r) => family(r.model) !== family(first.model)) ?? records[1] ?? null) : null;
    const winProbability = (a, b) => 1 / (1 + 10 ** ((b - a) / ELO_SCALE));
    const bestOf = (lab) => records.find((r) => r.lab === lab) ?? null;

    panels.push({
      panel: "ai_capability_gdpval_ratings",
      series_id: "Artificial Analysis GDPval-AA leaderboard (Elo on OpenAI's GDPval dataset of real knowledge-work tasks)",
      display_label: "GDPval head-to-head ratings",
      unit: "Elo rating points (400 points = 10:1 odds)",
      pool_version: board?.poolVersion ?? null,
      as_of: board?.lastRefreshed ?? null,
      top_matchup: first && second ? {
        model_a: first.model, lab_a: first.lab, elo_a: round1(first.elo),
        model_b: second.model, lab_b: second.lab, elo_b: round1(second.elo),
        elo_difference: round1(first.elo - second.elo),
        probability_a_beats_b_percent: round1(winProbability(first.elo, second.elo) * 100),
      } : null,
      leading_by_lab: ["Anthropic", "OpenAI", "Google"].map((lab) => {
        const r = bestOf(lab);
        return r ? { lab, model: r.model, elo: round1(r.elo), released: r.releaseDate } : { lab, model: null, elo: null, released: null };
      }),
      caveat: "these are model-versus-model comparisons with NO human in the pool, so the scale has no absolute anchor and a level means nothing on its own; only differences carry information. Ratings are frozen per pool version and must never be compared across versions. One model appears once per reasoning-effort setting",
      threshold: { rule: "descriptive context only; this panel votes on nothing" },
    });

    const expert = extras.gdpval?.expertWinRate ?? null;
    const rows = expert?.rows ?? [];
    const latestExpert = rows.length ? rows[rows.length - 1] : null;
    panels.push({
      panel: "ai_capability_vs_human_experts",
      series_id: "OpenAI GDPval, model wins plus ties against industry experts on the 220-task gold subset",
      display_label: "Did it clear a human",
      unit: "percent of tasks won or tied against an industry expert",
      latest_value: latestExpert ? round1(latestExpert.winsPlusTiesPct) : null,
      latest_model: latestExpert?.model ?? null,
      latest_date: latestExpert?.released ?? null,
      full_series: rows.map((r) => ({ model: r.model, released: r.released, wins_plus_ties_percent: round1(r.winsPlusTiesPct) })),
      // The publication gap is a fact about the instrument and the analyst must be
      // able to say so rather than treating the last reading as current.
      measurement_gap_after: expert?.measurementGapAfter ?? null,
      measurement_gap_note: expert?.measurementGapNote ?? null,
      parity_caveat: expert?.parityNote ?? null,
      true_parity_wins_only_percent: expert?.trueParityWinsOnlyPct ?? null,
      self_reported_caveat: expert?.selfReportedNote ?? null,
      threshold: { rule: "descriptive context only; this panel votes on nothing. This is the one capability measure with a human baseline, which is why it sits beside the rating comparison" },
    });
  }

  // --- AI capability: normalized benchmark tracks ---
  {
    const slots = extras.slots ?? [];
    panels.push({
      panel: "ai_capability_benchmarks",
      as_of: (() => {
        const ds = (extras.slots ?? []).map((x) => x.latestDate).filter(Boolean).sort();
        return ds.length ? String(ds[ds.length - 1]).slice(0, 7) : null;
      })(),
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

  // Vintage last, so it covers every panel above without each one remembering.
  return attachVintage(panels, extras.todayYm ?? new Date().toISOString().slice(0, 7));
}
