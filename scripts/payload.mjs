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
//
// --- panel_role: THE VOCABULARY ---------------------------------------------
//
// Every panel carries one, as of 2026-07-28. The prompt says a role BINDS where it
// is present, which made a missing role the most permissive state available: a panel
// with no role ran unconstrained, and the panels most likely to be over-read were
// exactly the ones that had never been given one. So the audit closed the gap rather
// than leaving the strongest claim to silence.
//
// A role says what a panel CAN ESTABLISH. It is never a verdict, and none of these
// strings may collide with a four-corner state name — the paired-state test asserts
// that, because a role field carrying the answer would be the withheld state arriving
// under a different label. (Named indirectly on purpose: that same test greps this
// file for any mention of the withheld module, which is how the blindness stays a
// structural guarantee rather than a convention.)
//
//   ATTRIBUTION         can show something is specific to AI-exposed work; cannot
//                       show work was destroyed
//   REABSORPTION        can show whether the outflow landed; cannot attribute
//   COMPOSITION_CONTROL can say whether an average moved because pay changed or
//                       because the population under it did
//   DEPLOYMENT_GATE     can permit a displacement reading; can never cause one
//   CONFOUNDER_CHECK    can name a competing cause; decides nothing itself
//   GAINS_TEST          can show whether the promised productivity gains are visible
//   DESCRIPTIVE         reports a quantity with no threshold and no vote
//   does_not_contribute shown for context, counted in nothing
//
// The lower-case odd one out is deliberate: it is the string the demotion brief
// specified, and matching it exactly is worth more than tidy casing.

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
  JOINT_BASELINE_SIGMAS,
  INDIVIDUAL_WAGE_GROWTH,
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
  // THE SAME SAMPLE THE FULL-HISTORY Z IS COMPUTED ON, latest excluded.
  //
  // These are printed side by side: an average and spread here, and next to them a
  // figure saying how unusual today is against that history. They were computed over
  // slightly different sets of months, because deviation() correctly leaves the latest
  // reading out of its own comparison window while this described every reading
  // including it. So a reader checking the arithmetic got a number close to but not
  // equal to the published one, which looks exactly like a bug.
  //
  // Excluding it here is the honest fix: it makes the printed stats describe the window
  // the z actually used. The alternative, back-solving a mean and standard deviation
  // that reproduce the published z, would be inventing figures to make a sum work.
  //
  // The fixed pre-2020 baseline needs no such treatment: it ends in 2019 and never
  // contains the latest reading in the first place.
  const full = usableSample(dated.slice(0, -1));
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
          window: `every reading from ${full[0][0]} to ${full[full.length - 1][0]} with ${UNUSABLE_START} to ${UNUSABLE_END} excluded, and the latest reading held out so it is not compared against itself`,
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

  // THE DRIFT PHRASE NAMES ITS OWN WINDOW (2026-07-29).
  //
  // It used to read "holding roughly flat" with no window attached, sitting a few lines
  // from a prior_reading that could show a large one-month move. Both were true — the
  // drift is measured over TREND_LOOKBACK_READINGS, so a sharp latest reading is
  // legitimately flat across four — but printed together with no window stated they
  // read as a contradiction, and an analyst dry run duly reported the panel as
  // internally inconsistent. It was the third time an unstated window on this dashboard
  // has been mistaken for an arithmetic error.
  //
  // The fix is to say which window the phrase describes, not to delete the phrase. A
  // four-reading drift and a one-month move are different facts and a reader is
  // entitled to both.
  const over = `over the last ${TREND_LOOKBACK_READINGS} readings`;
  let drift = `holding roughly flat ${over}`;
  if (zs.length >= TREND_LOOKBACK_READINGS) {
    const d = zs[zs.length - 1] - zs[zs.length - TREND_LOOKBACK_READINGS];
    if (d > TREND_DRIFT_Z) drift = `drifting further toward weakness ${over}`;
    else if (d < -TREND_DRIFT_Z) drift = `recovering ${over}`;
  }
  const condition = current === "steady"
    ? "inside the range its own 2010s history defined"
    : current === "watch" ? "modestly past its alarm line" : "well past its alarm line";
  const noun = consecutive === 1 ? "reading" : "readings";
  const prefix = censored ? "at least " : "";
  const tail = censored
    ? ` — the streak reaches the start of the observation window (${OBSERVATION_START}), so it may be longer than this`
    : "";
  return `${prefix}${consecutive} consecutive ${cadence} ${noun} ${condition} (spanning ${elapsed(months)}), ${drift}${tail}`;
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
/**
 * The name a falsifier cites to point at one of these.
 *
 * These ship as an unlabelled array, so a reading living in a supporting series had no
 * address. An analyst wanting to register "long-term unemployment falls back below 25"
 * could not write down which number that was, and had to retreat to the headline even
 * when a supporting series carried the real story. Keyed by the component itself so the
 * key travels with the number rather than depending on array position, which would
 * silently repoint if the order ever changed.
 */
function reabsorptionComponent(seriesId, label, unit, dated, orientSign, meaning, key = null) {
  const falsifierKey = key ? `secondary.${key}` : null;
  if (!dated.length) {
    return { series_id: seriesId, overturn_key: falsifierKey, display_label: label, available: false, note: "series absent from the pool this run" };
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
    overturn_key: falsifierKey,
    display_label: label,
    unit,
    what_it_reads: meaning,
    latest_value: round2(latest[1]),
    latest_date: latest[0],
    change_over_12_months: latestChange ? round2(latestChange[1]) : null,
    direction: dirOf(latestChange?.[1]),
    deterioration_direction: orientSign > 0 ? "rising is deterioration" : "falling is deterioration",
    // RAW changes, matching change_over_12_months directly above and every other
    // panel in this payload, which all pass raw values to long_run_context and orient
    // only the deviation.
    //
    // This previously passed the ORIENTED series, so the panel showed a raw latest
    // reading beside a sign-flipped baseline. The first live reader compared the two,
    // got a number that contradicted the reported deviation, and correctly reported
    // the panel as internally inconsistent. The arithmetic was right; the
    // presentation was a trap, and two adjacent fields in opposite sign conventions
    // is a defect whether or not anything downstream divides them.
    long_run_context_12m_changes: longRun(changes),
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
  const layoffs = datedOf(series[REABSORPTION.layoffsRate]);
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
        "long_term_unemployed_share",
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
          "hires_minus_quits",
        ),
        hires_rate: hires.length ? round2(hires[hires.length - 1][1]) : null,
        quits_rate: quits.length ? round2(quits[quits.length - 1][1]) : null,
        both_sides_note:
          "Name the moving side here too: this net figure falls both when hiring slows " +
          "and when quitting accelerates, and those are different stories. The two " +
          "underlying rates are given above.",
      },
      {
        // STRUCTURAL OR CYCLICAL — the distinction nothing else here can draw.
        //
        // Read this one WITH the hiring pace directly above it, never on its own.
        // Low hires and NORMAL layoffs is a frozen market: firms are not replacing
        // the people who leave, and the cost lands almost entirely on whoever is
        // trying to get in, which is what an AI-driven contraction in entry-level
        // work would look like. Low hires and ELEVATED layoffs is an ordinary
        // cycle: firms are shedding staff they already have. The reabsorption
        // headline reads the same on both, because an employment ratio cannot say
        // which side of the ledger moved.
        ...reabsorptionComponent(
          REABSORPTION.layoffsRate,
          "Pace of layoffs and discharges",
          "rate points (percent of employment, per month)",
          layoffs, +1,
          "Whether people are being pushed out, as opposed to simply not being hired. " +
          "Paired with the hiring pace above this separates a frozen labour market " +
          "from a shedding one.",
          "layoffs_rate",
        ),
        reading_rule_with_hires:
          "PAIR THIS WITH THE HIRING PACE ABOVE BEFORE SAYING ANYTHING ABOUT IT. Weak " +
          "hiring alongside layoffs at or below their norm is a FROZEN market: exits " +
          "are not being replaced, and the burden falls on entrants rather than on " +
          "incumbents. Weak hiring alongside ELEVATED layoffs is a CYCLICAL " +
          "contraction: firms are shedding people they already employ. Those are " +
          "different economies with different implications for an AI reading, and the " +
          "headline employment ratio is identical in both.",
      },
      reabsorptionComponent(
        `${REABSORPTION.u6} minus ${REABSORPTION.u3}`,
        "Underemployment gap (U-6 minus U-3)",
        "percentage points",
        underemployment, +1,
        "Whether people are landing but landing badly — part-time for economic " +
        "reasons, or discouraged out of the count entirely. A displacement episode " +
        "absorbed into worse work would widen this while the headline job count held.",
        "u6_minus_u3",
      ),
    ],
    componentVintages: {
      [REABSORPTION.primeAgeEpop]: epop.length ? epop[epop.length - 1][0] : null,
      [REABSORPTION.longTermUnemployedShare]: ltu.length ? ltu[ltu.length - 1][0] : null,
      [REABSORPTION.hiresRate]: hires.length ? hires[hires.length - 1][0] : null,
      [REABSORPTION.quitsRate]: quits.length ? quits[quits.length - 1][0] : null,
      [REABSORPTION.layoffsRate]: layoffs.length ? layoffs[layoffs.length - 1][0] : null,
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
 * Deterioration-positive 12-MONTH CHANGE in the prime-age employment share, against
 * raw zero. Positive means fewer prime-age people are working than a year ago.
 *
 * THIS COMMENT USED TO DESCRIBE THE OPPOSITE RULE (corrected 2026-08-06). It said
 * "POINTS BELOW 2019. A level, not a change", which is the version that was retired
 * — the body below has computed the change against zero since REABSORPTION_AXIS_LINE
 * was re-registered. A doc comment describing the rule its own function replaced is
 * the most expensive kind of stale prose, because the next person reads it instead
 * of the code.
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
 * WHERE THE TWO AXES SIT TOGETHER, against the range the calm decade occupied.
 *
 * WHY THIS IS SENT AND WHY IT IS NOT THE PAIRED STATE. Read the header of
 * the withheld state module first (which this file may not name, by test): the
 * the analyst, and the one-way dependency (that module imports from this one and
 * never the reverse) is the structural guarantee keeping it out of the request.
 *
 * Nothing here breaks that. No quadrant is named, no state is computed, no verdict
 * label appears. What is sent is a descriptive fact about the two axes the analyst
 * ALREADY receives: how far each month sits from the joint range of the fixed
 * baseline. That is the same kind of thing as the z-score every other panel carries,
 * and it is genuinely new information — it depends on the JOINT spread of a decade,
 * so an analyst holding the two axis values separately cannot reconstruct it.
 *
 * EVERY MONTH GOES AND THE PANDEMIC IS LABELLED RATHER THAN DROPPED. Sending only
 * the months outside the ring, or only the observation period, would hand the
 * analyst a selection and ask it to judge whether the selection was fair — which
 * cannot be done from a selection. The pandemic months are the most extreme in the
 * record and they are excluded from every statistic here; the analyst is entitled to
 * see them, weigh them, or say that excluding them does more work than this project
 * admits. As it happens 32 of the 36 are outside the ring too, so "outside the ring"
 * is not evidence of anything on its own — which is exactly why the window travels
 * with each month.
 */
export function jointBaselinePosition(pool) {
  const attribution = attributionAxisOriented(pool);
  const reabsorption = reabsorptionAxisOriented(pool);
  if (!attribution.length || !reabsorption.length) return null;

  // Scored against the WHOLE fixed baseline, one yardstick for every month. The path
  // that builds the trail deliberately scores each month against history up to itself, to
  // avoid hindsight when reconstructing what a past reading looked like at the time.
  // This asks a different question — where does this month sit against the calm decade
  // — and for that a growing yardstick would mean earlier months were judged by less.
  const attrBase = attribution.filter(([m]) => inBaseline(m)).map(([, v]) => v);
  const reabBase = reabsorption.filter(([m]) => inBaseline(m)).map(([, v]) => v);
  if (attrBase.length < BASELINE_MIN_READINGS || reabBase.length < BASELINE_MIN_READINGS) return null;

  const meanOf = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const sdOf = (a, m) => Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / a.length);
  const cx = meanOf(attrBase); const sx = sdOf(attrBase, cx);
  const cy = meanOf(reabBase); const sy = sdOf(reabBase, cy);
  if (sx <= 0 || sy <= 0) return null;
  const rx = sx * JOINT_BASELINE_SIGMAS;
  const ry = sy * JOINT_BASELINE_SIGMAS;

  const reab = new Map(reabsorption);
  const windowOf = (m) =>
    m >= UNUSABLE_START && m <= UNUSABLE_END ? "PANDEMIC"
      : m >= OBSERVATION_START ? "OBSERVATION" : "BASELINE";

  // TUPLES, NOT OBJECTS. Every month is sent — that is the whole point, and it is not
  // negotiable — but repeating five field names 197 times costs about 16KB of the
  // model's context for no information at all. A stated schema plus positional rows
  // carries the same content in roughly a third of the tokens. Retaining the data and
  // spending tokens on it are different decisions.
  const months = [];
  for (const [m, attrRaw] of attribution) {
    if (!reab.has(m)) continue; // a month missing either axis cannot be placed
    const y = reab.get(m);
    const u = (attrRaw - cx) / rx; const v = (y - cy) / ry;
    months.push([
      m,
      round2((attrRaw - cx) / sx),
      round2(-y), // published sign: negative = employment fell
      windowOf(m),
      u * u + v * v <= 1,
    ]);
  }
  const tally = (pred) => months.reduce((acc, r) => {
    if (pred(r)) acc[r[3]] = (acc[r[3]] ?? 0) + 1;
    return acc;
  }, {});

  // GAPS ARE NAMED, NOT LEFT SILENT (2026-08-07). A month missing either axis is
  // skipped above, which leaves a hole a reader of the table cannot see: the rows
  // are consecutive-looking, so a trajectory read off them appears continuous and
  // its turning points appear to sit on months that are merely the nearest
  // SURVIVING months. That is not hypothetical — October 2025 is absent here
  // (the CPS response gap), and October 2025 happens to be the exact trough of the
  // attribution gap's two-year narrowing. An analyst reconstructing the path from
  // this table dates the turn to November and cannot know October existed.
  //
  // Found by a model reading the payload, which noticed the discontinuity and
  // correctly narrowed its own claim about the trough date. It should not have had
  // to infer it.
  const missing = [];
  for (let i = 1; i < months.length; i++) {
    if (monthsBetween(months[i - 1][0], months[i][0]) !== 1) {
      missing.push(...monthsBetweenExclusive(months[i - 1][0], months[i][0]));
    }
  }

  return {
    sigmas: JOINT_BASELINE_SIGMAS,
    baseline_window: `${BASELINE_START}..${BASELINE_END}`,
    // The centre and radii are quoted in the SAME units as the month rows below.
    // Sideways is a z, so its radius is the sigma count exactly, by construction.
    // Up-down is in points a year, so its radius is in points.
    centre: { attribution_z: 0, employment_change_12m: round2(-cy) },
    radii: { attribution_z: JOINT_BASELINE_SIGMAS, employment_change_12m: round2(ry) },
    total_by_window: tally(() => true),
    outside_by_window: tally((r) => !r[4]),
    months_format: "[month, attribution_z, employment_change_12m, window, inside_baseline_range]",
    months,
    months_absent: missing,
    months_absent_note: missing.length
      ? "These months fall inside the span of the table and are NOT in it, because one of " +
        "the two axes has no reading for them. The rows above are therefore not evenly " +
        "spaced. Do not read a turning point as sitting on a listed month without checking " +
        "this list first — the true turn may fall in a gap, and a slope measured across one " +
        "is measured over more than a month."
      : "No gaps: every month between the first and last row is present.",
    note:
      "The range both axes occupied together through the fixed baseline decade, at " +
      `${JOINT_BASELINE_SIGMAS} standard deviations per axis. A month outside it is one where the ` +
      "COMBINATION of the two readings is unusual against that decade, which neither axis " +
      "shows on its own. It is not a threshold and nothing fires on it. Note that most " +
      "pandemic months are outside it too, for reasons that have nothing to do with AI — " +
      "which is why every month is sent with the window it belongs to rather than filtered.",
  };
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
      "THIS IS NOT COMPARABLE TO THE PAYROLL FIGURE IN THE NEWS PACKAGE, and the two " +
      "will look wildly inconsistent if read side by side. This decomposition is the " +
      "household survey (CPS), restricted to ages 25 to 54, over twelve months. The " +
      "payroll headline is the establishment survey (CES), all ages, over one month. " +
      "Three different things differ at once, so a large negative here sitting beside " +
      "a small positive there is not a contradiction and neither figure is wrong. Do " +
      "not net them, and do not describe one as refuting the other. " +
      "READ THE DIRECTIONS, NOT THE MAGNITUDES, AND DISCOUNT THE POPULATION LEG " +
      "HARDEST. The population series is not seasonally adjusted and, more " +
      "importantly, the Census population controls are revised every January, which " +
      "puts a LEVEL SHIFT into the series at the turn of each year: this series jumped " +
      "about +1.9 million at January 2025 and fell about -1.5 million at January 2026, " +
      "neither of which is people arriving or leaving. Any twelve-month comparison " +
      "necessarily spans one of those revisions, so the population change here is " +
      "partly an artefact and its size should not be quoted. " +
      // CORRECTED 2026-08-07. This used to read "Employment is seasonally adjusted and
      // does not carry the same discontinuity", which was wrong and wrong in the
      // direction that invites over-reading. Seasonal adjustment removes a seasonal
      // pattern; it cannot remove a re-weighting break, and these are different
      // mechanisms. CPS employment LEVELS are the sample weighted to the population
      // controls, so when the controls re-base the levels step with them. Measured in
      // this pool: the seasonally adjusted prime-age employed series moved +1,724k at
      // January 2025 and -1,024k at January 2026, against a typical month of ±100-250k.
      // The January 2026 step alone is about 71% of the twelve-month decline this block
      // reports. Caught by a model reading the payload and checking the claim rather
      // than accepting it.
      "THE EMPLOYMENT LEG CARRIES THE SAME BREAK, and the earlier version of this note " +
      "wrongly said it did not. Seasonal adjustment does not undo a control re-basing: " +
      "this employed series stepped about +1.7 million at January 2025 and about -1.0 " +
      "million at January 2026, against a typical month of one to two hundred thousand. " +
      "Any twelve-month change here therefore spans a break on BOTH legs, and neither " +
      "figure's size should be quoted. " +
      "The published ratio itself is the reliable measure, because numerator and " +
      "denominator re-base together and it is computed consistently within each " +
      "control regime — verified in this pool, where the ratio's January steps (0.2 and " +
      "0.1 points) sit inside its ordinary monthly variation. This decomposition is a " +
      "direction check on that ratio, nothing more.",
    what_this_does_and_does_not_settle:
      "It can tell you whether employment is falling at all, which is the question " +
      "that matters: if employment is down year-over-year then the share cannot be " +
      "falling merely because more people arrived. It cannot tell you how much of the " +
      "ratio's move each side contributed, and it should not be used that way.",
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
/**
 * The employment-size classes the app actually draws: smallest, the two where the climb
 * becomes visible, and largest.
 *
 * MUST MATCH CHARTED_SIZE_BANDS in the app's ExtendedChartSpecs.kt. All seven are
 * fetched and stored, and the middle three (5-9, 10-19, 20-49) sat within a couple of
 * points of their neighbours — lines without information on a chart whose whole range is
 * fifteen points. They are dropped from the payload as well as the chart for the reason
 * every unrendered panel is: a figure the analyst can cite has to be one a reader can
 * check on a chart, and sending a band the app does not draw breaks that.
 */
const CHARTED_SIZE_CLASSES = new Set(["A", "E", "F", "G"]);

function adoptionBySize(bySize) {
  if (!bySize) return null;
  const bands = [];
  // Prefers the published band ARRAY (all seven classes, added 2026-07-29) and falls
  // back to the older named-slot shape so a stale snapshot still renders. The named
  // slots only ever carried the two extremes, which is why the gradient below could
  // previously be read as a direction and not as a distribution.
  const source = Array.isArray(bySize.bands) && bySize.bands.length
    ? bySize.bands.filter((b) => CHARTED_SIZE_CLASSES.has(b.code))
    : ["smallest", "small", "mid", "large", "larger", "largest"]
        .map((key) => bySize[key])
        .filter(Boolean);
  for (const b of source) {
    if (!b?.points?.length) continue;
    const pts = b.points;
    const latest = pts[pts.length - 1];
    const first = pts[0];
    bands.push({
      band: b.label ?? b.code ?? "unlabelled size class",
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

/** The months strictly between two endpoints — the hole, not the edges. */
function monthsBetweenExclusive(ymA, ymB) {
  const out = [];
  for (let i = 1; i < monthsBetween(ymA, ymB); i++) out.push(ymAdd(ymA, i));
  return out;
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
      panel_role: "GAINS_TEST",
      panel_role_note:
        "Whether the productivity gains AI is supposed to deliver are visible in the " +
        "aggregate at all. It is ECONOMY-WIDE, so it can never attribute anything to " +
        "AI-exposed work, and it is slow and heavily revised. Read it as a check on " +
        "the augmentation story rather than as evidence for or against displacement: " +
        "gains showing up is what augmentation working would look like; gains absent " +
        "is consistent with several things, including the technology being too new to " +
        "register.",
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
      // 2dp on all three, not 1dp. At 1dp the two sides did not sum to the
      // differential sitting beneath them (-1.3 and 1.3 against -2.5), which is the
      // first arithmetic a careful reader checks; the first live reader to check it
      // reported the panel as internally broken, and was right to.
      //
      // The differential and its trigger matter more than readability here because
      // the falsifier resolver compares them numerically. At 1dp a true -2.549
      // published as -2.5 against a trigger of -2.5 scored as "at or above" and
      // resolved a falsifier that had not actually been met.
      exposed_value: round2(last?.exposed),
      control_value: round2(last?.control),
      // Rounded once from the unrounded series, not derived from the two figures
      // above, so it stays the most accurate value for the resolver to compare.
      differential_exposed_minus_control: round2(last?.diff),
      rounding_note:
        "exposed_value and control_value are each rounded to two decimals for display. " +
        "differential_exposed_minus_control is computed from the unrounded series and " +
        "rounded once, so it can differ from the subtraction of the two figures above " +
        "by up to 0.01. That is rounding, not an inconsistency, and the differential is " +
        "the figure to reason from.",
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
      threshold: { differential_trigger: round2(trigger), rule: `the attribution line is the exposed-minus-control gap falling two standard deviations below its ${BASELINE_START} to ${BASELINE_END} average. This fires on the LEVEL of the gap, not on whether it is still widening: a gap parked past the line keeps counting. Whether a stalled gap or a widening one is the newsworthy part is a judgement left to the analyst rather than wired into the trigger. Crossing it means AI-exposed work is diverging, not that anyone was displaced` },
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
      // WHERE THE TWO AXES SIT TOGETHER, against the calm decade's joint range.
      //
      // Attached here rather than made its own panel, because it is not a measurement
      // of its own: it is a statement about this panel and the exposed-vs-control jobs
      // panel read together, and a separate panel entry would make it nameable as
      // load-bearing when there is nothing extra to look at.
      //
      // Carries no quadrant, no state and no verdict label. See the function's own
      // comment, and the withheld state module's own header, for why that boundary is
      // structural rather than a matter of taste.
      joint_position_with_attribution: jointBaselinePosition(pool),
      headline: {
        ...r.headline,
        // WHY the ratio moved: employment, or population. A ratio can fall two ways
        // and they mean opposite things — people losing work, versus a growing
        // working-age population the job market has not absorbed yet. The panel says
        // which rather than leaving the analyst to assume, and reports rather than
        // resolves. Null until the pool carries both halves.
        decomposition: reabsorptionDecomposition(pool),
        // The reference level is DESCRIPTIVE now: the axis is placed on the 12-month
        // change against zero, not on distance from this year. Kept because "where
        // does today sit against 2019" is a question a reader will ask anyway.
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
      // NAMED so a falsifier can point at one. These ship as an unlabelled array, so a
      // reading that lives in a supporting series had no address: an analyst wanting to
      // register "long-term unemployment falls back below 25" could not write down which
      // number it meant, and had to fall back to the headline even when a supporting
      // series was the real story. The key is what a falsifier cites.
      secondary_readouts: r.secondary,
      reading_rule:
        "The HEADLINE places this axis, on its 12-month change. The four secondary " +
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
      panel_role: "ATTRIBUTION",
      panel_role_note:
        "The same exposed-versus-control cut as the jobs panel, on pay instead of " +
        "headcount, so it carries the same limit: it can show something is specific " +
        "to AI-exposed work and it cannot show that work was destroyed. It carries one " +
        "further limit the jobs panel does not, and it is severe — this is an AVERAGE " +
        "over a group whose membership changes, so it can move with nobody's pay " +
        "changing at all. See measurement_artifact, and check it against the " +
        "individual_wage_growth panel before leaning on it.",
      unit: "percent (year-over-year pay growth)",
      // 2dp on the sides, up from 1dp. At 1dp this panel published 4.6 and 3.5 beside
      // a differential of 1.11, a gap of 0.01 that looked like an arithmetic error.
      // The jobs panel was fixed for this; the wages panel was missed.
      exposed_value: round2(last?.exposed),
      control_value: round2(last?.control),
      // Computed at full precision and rounded once, NOT derived from the two rounded
      // sides above. This is the field a falsifier registers against, so it carries
      // the most accurate value available rather than one degraded to make the
      // subtraction display neatly. The two can therefore still differ by 0.01, which
      // is what rounding_note exists to say out loud.
      differential_exposed_minus_control: round2(last?.diff),
      rounding_note:
        "exposed_value and control_value are each rounded to two decimals for display. " +
        "differential_exposed_minus_control is computed from the unrounded series and " +
        "rounded once, so it can differ from the subtraction of the two figures above " +
        "by up to 0.01. That is rounding, not an inconsistency, and the differential is " +
        "the figure to reason from.",
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
        // COMPOSITION, SPELLED OUT AND GIVEN A CROSS-CHECK (2026-07-28).
        //
        // The rule above already said to discount this panel when exposed employment
        // is falling, and it was not enough, because it named no mechanism and
        // offered nothing to check the figure against. This panel currently shows
        // exposed pay growing about 1.1 points FASTER than control, which is the
        // single strongest piece of evidence against a displacement reading — and it
        // is exactly the number a hiring freeze would produce with nobody receiving
        // a raise. An analyst that cannot tell those apart should not be citing it.
        composition_artifact:
          "THIS IS AN AGGREGATE INDUSTRY AVERAGE AND THE POPULATION UNDER IT CAN " +
          "CHANGE. The mechanism to work through: if entry-level hiring in exposed " +
          "industries stops, the workers who remain skew senior, and average pay " +
          "across the group RISES with no individual getting a raise and no employer " +
          "bidding for anyone. The average went up because the juniors left the " +
          "denominator. That effect is largest precisely when hiring patterns are " +
          "shifting, which is the condition this dashboard exists to detect, so the " +
          "artifact is worst exactly where the panel matters most.",
        composition_cross_check:
          "The individual_wage_growth panel is the control for this, and it is the " +
          "reason that panel exists. It follows THE SAME PEOPLE twelve months apart, " +
          "so composition cannot move it. Compare the two before citing this one: if " +
          "this panel shows exposed pay accelerating while the individual-level " +
          "tracker is flat or falling, the acceleration here is telling you who is " +
          "left rather than who was paid more. The cross-check is economy-wide, so it " +
          "cannot confirm an exposed-industry story on its own — it can only tell you " +
          "whether the aggregate reading survives the composition question.",
        weighting_rule:
          "Weight this panel by the sign of exposed employment change. If exposed employment is " +
          "RISING, the composition story cannot explain rising pay and this is clean evidence. If " +
          "exposed employment is FALLING, this panel cannot distinguish augmentation from " +
          "displacement and must not be cited as strong support for either. Where the " +
          "individual-level tracker disagrees with this panel, treat the composition " +
          "question as unresolved and let it weaken this reading rather than reporting " +
          "the figure at face value.",
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
      threshold: { differential_trigger: round2(trigger), rule: "the alarm is exposed pay growth falling two standard deviations below control's, off the calm-period average" },
    });
  }

  // --- Individual-level wage growth: stayers vs switchers (new 2026-07-28) ---
  //
  // THE COMPOSITION CONTROL on the panel directly above. Every other pay reading
  // here is an industry average, and an average moves when the GROUP changes even if
  // no individual's pay does. This tracker follows the same people twelve months
  // apart and reports the median of their own wage changes, so composition cannot
  // move it. Where the two disagree, the disagreement IS the finding.
  {
    const stayer = datedOf(series[INDIVIDUAL_WAGE_GROWTH.jobStayer]);
    const switcher = datedOf(series[INDIVIDUAL_WAGE_GROWTH.jobSwitcher]);
    const premium = spreadOf(switcher, stayer);
    const lastStayer = stayer.length ? stayer[stayer.length - 1] : null;
    const lastSwitcher = switcher.length ? switcher[switcher.length - 1] : null;
    const lastPremium = premium.length ? premium[premium.length - 1] : null;
    // ABSENCE IS STATED, NEVER SHIPPED AS NULLS. These two series were wired
    // 2026-07-28 and reach the pool on the next FRED refresh, so between those two
    // events this panel has no data. A panel of bare nulls reads as "no wage growth"
    // rather than "not measured", and the whole point of this one is to be the check
    // another panel is weighed against — a silently empty check would quietly restore
    // the reading it exists to qualify.
    const available = stayer.length > 0 && switcher.length > 0;
    panels.push({
      panel: "individual_wage_growth",
      ...(available ? {} : {
        available: false,
        unavailable_reason:
          "The Atlanta Fed wage tracker series are wired but are not in the data pool " +
          "yet; they arrive on the next FRED refresh. TREAT THIS AS MISSING, NOT AS " +
          "ZERO AND NOT AS REASSURANCE. This panel is the composition control on the " +
          "exposed-vs-control pay panel, so while it is absent the composition " +
          "question on that panel is UNRESOLVED rather than answered, and its " +
          "figures should be weakened accordingly rather than read at face value.",
      }),
      as_of: lastStayer?.[0] ?? null,
      series_id: `${INDIVIDUAL_WAGE_GROWTH.jobStayer} (job stayers), ${INDIVIDUAL_WAGE_GROWTH.jobSwitcher} (job switchers) — Atlanta Fed Wage Growth Tracker, 12-month moving average of the unweighted median hourly wage growth`,
      display_label: "Pay growth for the same people: stayers vs switchers",
      panel_role: "COMPOSITION_CONTROL",
      panel_role_note:
        "This is the composition-immune cross-check on the exposed-vs-control pay " +
        "panel, and it is economy-wide rather than exposed-industry, so it CANNOT " +
        "attribute anything to AI-exposed work by itself. What it can do is tell you " +
        "whether a move in an industry AVERAGE is people being paid differently or " +
        "different people being in the average. Use it that way and not as a fourth " +
        "vote. It also carries the cleanest reading available on whether people who " +
        "move jobs are landing WELL.",
      unit: "percent (median wage growth over the past year, same individuals)",
      job_stayer_value: round2(lastStayer?.[1]),
      job_switcher_value: round2(lastSwitcher?.[1]),
      switcher_premium: round2(lastPremium?.[1]),
      latest_date: lastStayer?.[0] ?? null,
      prior_reading: priorReading(premium),
      switcher_premium_reading: lastPremium == null ? "no reading available"
        : lastPremium[1] > 0
          ? `Switchers are ahead of stayers by ${round2(lastPremium[1])} points, so changing ` +
            `jobs currently pays. That is what OPPORTUNITY-DRIVEN mobility looks like: ` +
            `people are moving because somewhere else is bidding for them.`
          : `Switchers are BEHIND stayers by ${round2(-lastPremium[1])} points, so people who ` +
            `change jobs are taking less than those who stay. That is what FORCED mobility ` +
            `looks like, and it is the pattern a displacement episode absorbed into worse ` +
            `work would produce while the headline employment count held up.`,
      measurement_artifact: {
        text:
          "This is a CPS-based measure, and the CPS has been degraded through this " +
          "period. Response rates fell through late 2025, OCTOBER 2025 IS MISSING " +
          "ENTIRELY from both series at source, and the confidence intervals around " +
          "these medians are wider than usual as a result. It is also a MEDIAN of " +
          "individual wage changes rather than a mean, so it says nothing about the " +
          "tails: a collapse concentrated in a minority of workers is exactly the " +
          "shape this measure would miss.",
        weighting_rule:
          "Read moves of a couple of tenths as noise, especially across the October " +
          "2025 hole. What this panel is FOR is the comparison against the " +
          "exposed_vs_control_wages panel, which is an industry average and can move " +
          "on composition alone. If that panel shows exposed pay accelerating while " +
          "this one is flat or falling, the industry figure is probably telling you " +
          "who is left rather than who got a raise.",
        population_caveat:
          "ECONOMY-WIDE. It covers every industry and cannot be cut to exposed versus " +
          "control, so it can never be evidence about AI-exposed work specifically.",
      },
      long_run_context_switcher_premium: longRun(premium),
      // Deterioration-oriented: the switcher premium SHRINKING is the direction that
      // means mobility is turning forced, so a falling premium reads positive here.
      deviation_from_normal: deviation(premium.map(([m, v]) => [m, -v])),
      streak: streakString(premium.map(([m, v]) => [m, -v]), "monthly"),
      threshold: {
        rule:
          "NO THRESHOLD AND NO ALARM LINE, deliberately. This panel exists to " +
          "disqualify or corroborate another panel's reading, not to fire on its own, " +
          "and a trigger here would invite exactly the fourth-vote reading the " +
          "panel_role forbids. Read the level, the spread and the direction.",
      },
    });
  }

  // --- Job postings spread (Indeed; both sides) ---
  {
    const pp = extras.postingsPoints ?? [];
    const last = pp[pp.length - 1] ?? null;
    // No twoSigmaTrigger call here any more. It returned null anyway — this series
    // cannot cover the fixed baseline — and computing a line only to discard it
    // invited someone to "fix" the null by falling back to a contaminated window,
    // which is exactly what the app was doing. See the threshold block below.
    panels.push({
      panel: "job_postings_spread",
      series_id: "Indeed Hiring Lab job postings, exposed knowledge-work occupations vs control hands-on occupations",
      display_label: "Job postings: exposed vs control occupations",
      panel_role: "ATTRIBUTION",
      panel_role_note:
        "Attribution, and the earliest of the three: postings move before headcount " +
        "does, which is what makes this the panel most likely to be right first when " +
        "it disagrees with the others. It is also cut by OCCUPATION rather than " +
        "industry, so it is a better proxy for exposure than the jobs panel — a fact " +
        "worth stating whenever the two disagree. What it cannot do is establish " +
        "displacement, and it cannot even establish a current condition from its level " +
        "alone: see measurement_artifact, because this spread opened in 2022 and has " +
        "been flat since, so the change is the signal and the level is history.",
      unit: "index points, each side against its OWN February 2020 level = 100",
      // Both sides are sent as levels, not just the spread, and the baseline is
      // stated per side: a spread of -28 is a very different fact when exposed
      // sits a quarter below its pre-pandemic level while control sits above its own.
      exposed_value: last ? round1(last.exposed) : null,
      exposed_vs_own_prepandemic_baseline: last ? round1(last.exposed - 100) : null,
      control_value: last ? round1(last.control) : null,
      control_vs_own_prepandemic_baseline: last ? round1(last.control - 100) : null,
      // 2dp, not integer. This is a registerable falsifier field, and at integer
      // precision a true -27.6 publishes as -28 and can resolve a trigger of -28 that
      // was never actually met. That is the same failure the jobs panel was fixed for.
      // The source data carries a decimal, so nothing here is invented.
      spread_exposed_minus_control: last ? round2(last.spread) : null,
      spread_change_over_6_months: last && pp.length > 6 ? round2(last.spread - pp[pp.length - 7].spread) : null,
      latest_date: last ? last.date.slice(0, 7) : null,
      prior_reading: priorReading(pp.map((p) => [p.date.slice(0, 7), p.spread])),
      long_run_context: longRun(pp.map((p) => [p.date.slice(0, 7), p.spread]), "job_postings_spread"),
      deviation_from_normal: deviation(pp.map((p) => [p.date.slice(0, 7), -p.spread])),
      history_caveat: "this series begins February 2020, so it has no pre-pandemic baseline and a shorter calm history than the other panels",
      // WHICH SIDE MOVED, AND WHERE THE DEMAND WENT.
      //
      // Promoted to first-class fields 2026-07-29, at the same time the trigger was
      // deleted. The spread alone cannot say whether knowledge-work demand collapsed
      // or hands-on demand surged, and those are different economies. Both sides are
      // already given above against their own pre-pandemic level; this states the
      // reading they support, because it is the closest thing on this dashboard to a
      // direct observation of demand ROTATING rather than disappearing.
      both_sides_reading: (() => {
        if (!last) return "no reading available";
        const ex = round1(last.exposed - 100);
        const co = round1(last.control - 100);
        const base =
          `Knowledge-work postings sit ${ex >= 0 ? `${ex} percent ABOVE` : `${Math.abs(ex)} percent BELOW`} ` +
          `their own February 2020 level; hands-on postings sit ` +
          `${co >= 0 ? `${co} percent ABOVE` : `${Math.abs(co)} percent BELOW`} theirs. `;
        if (ex < 0 && co > 0) {
          return base +
            `Read this as ATTRIBUTION and nothing more: the weakness is specific to ` +
            `knowledge work rather than general, because a broad contraction pulls both ` +
            `sides down together and this has not. ` +
            `WHAT IT IS NOT EVIDENCE OF. It is not evidence of augmentation. On this ` +
            `panel augmentation would be knowledge-work postings RECOVERING toward their ` +
            `own baseline; hands-on postings being strong is a fact about hands-on work ` +
            `and says nothing about whether the exposed side is being made more valuable. ` +
            `Nor is it evidence that anyone was absorbed. Demand shifting between kinds ` +
            `of work does not mean workers shifted with it: the skills are different, ` +
            `many displaced knowledge workers would be overqualified or unsuited for the ` +
            `roles that are growing, and a posting is an advertised intention rather than ` +
            `a filled job. A knowledge worker who ends up in a hands-on role has not been ` +
            `augmented. Whether anybody landed, and whether they landed WELL, is settled ` +
            `by the reabsorption panel and the individual-level pay tracker, not here.`;
        }
        if (ex < 0 && co < 0) {
          return base +
            `Both sides are below their own pre-pandemic level, which is the signature of ` +
            `a general contraction rather than of anything specific to AI-exposed work. ` +
            `Say which side is further down and by how much before drawing any ` +
            `exposure-specific conclusion.`;
        }
        return base +
          `Read the two sides, not the gap between them. The gap alone cannot say which ` +
          `side moved, and the two mean different things.`;
      })(),
      // THE CHANGE IS THE SIGNAL, NOT THE LEVEL (2026-07-28).
      measurement_artifact: {
        text:
          "THIS SPREAD OPENED IN 2022 AND HAS BEEN ROUGHLY FLAT SINCE. It opened before " +
          "current AI tools had diffused into hiring decisions, and published work on " +
          "the postings collapse attributes much of the initial opening to interest " +
          "rates: rate-sensitive white-collar hiring was cut first and hardest, and the " +
          "timing lines up with the tightening cycle rather than with any model " +
          "release. So the LEVEL of this spread is substantially a 2022 event that is " +
          "still sitting there, and a wide reading today is mostly a fact about 2022.",
        weighting_rule:
          "READ THE CHANGE, NOT THE LEVEL. A wide spread that has not moved in years " +
          "is a standing condition, and describing it as though it were news is the " +
          "main way this panel misleads. What would be evidence is the spread moving: " +
          "widening again, or closing. spread_change_over_6_months is the field for " +
          "that. When you cite this panel, say which of the two you are reading, and " +
          "name the side that moved rather than the gap.",
      },
      streak: streakString(pp.map((p) => [p.date.slice(0, 7), -p.spread]), "monthly"),
      threshold: {
        rule:
          "NO THRESHOLD, NO TRIGGER LINE AND NO ALARM. Deleted 2026-07-29 rather than " +
          "moved onto the rate of change, and the deletion is a public re-registration " +
          "rather than maintenance. Three reasons, and the third is decisive. " +
          "First, this series begins 2020-02, so it can never cover the fixed " +
          "2010-2019 baseline every other threshold on this dashboard is drawn against; " +
          "any line here has to be computed from a window that IS the period under test, " +
          "which is the circularity the fixed baseline exists to prevent. " +
          "Second, the line fired on the LEVEL, and the level is substantially a 2022 " +
          "event that has not moved since, so it could sit tripped for years while " +
          "reading to a viewer as a live alarm. " +
          "Third, relocating it onto the change would not have fixed either problem. It " +
          "would compute a different threshold off the same contaminated window, and it " +
          "would still be a pre-registered line standing between a reader and the series. " +
          "The job here is to tell the whole story, and the threshold was secondary to " +
          "that and getting in its way. " +
          "Read instead: where each side sits against its own pre-pandemic level, which " +
          "direction the spread has moved over six months, and the rotation reading above. " +
          "Do not treat the absence of a threshold as either reassurance or alarm.",
      },
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
      panel_role: "DESCRIPTIVE",
      panel_role_note:
        "No threshold, no alarm line, no vote — see the threshold block for why that " +
        "is a re-registration rather than missing data. ECONOMY-WIDE, so it cannot be " +
        "evidence about AI-exposed work whatever it does, and it has fallen since the " +
        "1970s for causes that predate AI by decades. It can tell you where the level " +
        "sits in its own record and how fast it has moved over a stated horizon. It " +
        "cannot tell you that AI moved it.",
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

  // THE RECENT-GRADUATE GAP IS NOT SENT AT ALL (2026-07-29), having previously been
  // sent with a does_not_contribute role telling the analyst not to count it.
  //
  // Two reasons, and the second is the stronger. The panel is not differenced on AI
  // exposure: it compares recent graduates against GENERAL unemployment, so both sides
  // move with the business cycle, and an ordinary recession that hits young workers
  // hardest widens it exactly as an AI-driven collapse in entry-level knowledge work
  // would. Nothing in it can separate the two.
  //
  // And it is no longer drawn in the app, which is what settles it. Every figure the
  // analyst cites is meant to be checkable by a reader on a chart one tap away, and that
  // promise breaks the moment the payload carries a series the app does not show.
  // Supplying a panel while instructing the model not to use it is also just a
  // temptation with a label on it: the honest way to make something uncountable is not
  // to send it. The same reasoning removed the benchmark-tracks panel below.
  //
  // The version worth building is young workers in AI-exposed occupations against young
  // workers in non-exposed ones, which differences on both dimensions so the cycle
  // cancels. FRED publishes unemployment by occupation and unemployment by age and
  // nothing crossing the two, so it needs CPS microdata.

  // --- AI adoption (Type B gate) ---
  {
    const ap = extras.adoptionPoints ?? [];
    const last = ap[ap.length - 1] ?? null;
    const rising = ap.length >= 2 && last.pct > ap[Math.max(0, ap.length - ADOPTION_RISING_LOOKBACK)].pct;
    panels.push({
      panel: "ai_adoption",
      series_id: "US Census Bureau Business Trends and Outlook Survey, share of firms using AI",
      display_label: "Firms using AI in any business function",
      panel_role: "DEPLOYMENT_GATE",
      panel_role_note:
        "A weak-form gate, and the direction of the logic is the whole point: real " +
        "adoption PERMITS a displacement reading, and no amount of adoption CAUSES " +
        "one. You cannot call it AI displacement with no deployment; you also cannot " +
        "call it AI displacement from deployment alone, because firms adopting a tool " +
        "is not an event in anyone's employment. It counts firms rather than workers, " +
        "which understates worker exposure whenever adoption rises with employer size, " +
        "and it does here.",
      unit: "percent (of firms)",
      latest_value: last ? round1(last.pct) : null,
      // YYYY-MM, matching prior_reading and full_series just below. This alone
      // shipped a full ISO date, so anything comparing them found no match.
      latest_date: last?.date?.slice(0, 7) ?? null,
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
      panel_role: "DESCRIPTIVE",
      panel_role_note:
        "Weak directional context on HOW AI is being used, and nothing more. It " +
        "measures one vendor's conversations over a user base that changes between " +
        "releases, and conversations are not jobs — a shift in who is using the " +
        "product moves this with no change in how anyone works. It is also the " +
        "stalest panel here while measuring the fastest-moving thing on the " +
        "dashboard. It cannot establish anything about employment in either " +
        "direction; a move is worth mentioning only if it is large and sustained " +
        "across several releases.",
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
      panel_role: "CONFOUNDER_CHECK",
      panel_role_note:
        "This can NAME a competing cause. It cannot clear one. The curve is " +
        "forward-looking — it prices what investors expect, not what has already " +
        "happened — so it can never exculpate weakness already sitting in the data, " +
        "and the contemporaneous test on the control panels is the one that settles " +
        "whether observed weakness is general. Use this to generate the cyclical " +
        "hypothesis and the control industries to test it.",
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
      panel_role: "does_not_contribute",
      panel_role_note:
        "SHOWN FOR CONTEXT, COUNTED IN NOTHING. This was a capability gate until July " +
        "2026 and now conditions nothing: a benchmark of clean, self-contained " +
        "software tasks should not decide whether a real labor signal counts. What a " +
        "model can do on auto-scorable problems is not what happened to any worker, " +
        "and it cannot corroborate a labor reading in either direction.",
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
      // Demoted 2026-07-28. Nothing on the causal chain runs through which lab is
      // ahead, so this cannot corroborate a labor reading in either direction.
      panel_role: "does_not_contribute",
      panel_role_note:
        "SHOWN FOR CONTEXT, COUNTED IN NOTHING. This measures what models can do " +
        "against each other. No link in the displacement chain runs through which lab " +
        "leads: a model pulling ahead of another model is not an event in anyone's " +
        "employment, and the two are not even on the same clock, since a capability " +
        "release and the labor response to it are separated by however long deployment " +
        "takes. Read it, say anything interesting you notice, and do not count it as " +
        "support for or against the verdict.",
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
      // Demoted 2026-07-28, alongside the ratings panel. This is the capability
      // measure with a human baseline, which makes it the most tempting one to count
      // and no more entitled to be counted.
      panel_role: "does_not_contribute",
      panel_role_note:
        "SHOWN FOR CONTEXT, COUNTED IN NOTHING. Clearing an expert on a benchmark task " +
        "is not the same event as an employer choosing to stop paying that expert, and " +
        "only the second one is labor evidence. This panel is the most persuasive-" +
        "looking capability reading here precisely because it has a human on the other " +
        "side of it, which is the reason to be careful with it rather than a reason to " +
        "weight it. It cannot corroborate a labor reading in either direction.",
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

  // THE BENCHMARK-TRACKS PANEL IS NOT SENT (2026-07-29), for the same reason as the
  // recent-graduate gap: it is not rendered anywhere in the app, so nothing the analyst
  // said about it could be checked by a reader against a chart. It was also the weakest
  // capability panel on offer, several of its benchmarks being near saturation where a
  // score stops distinguishing models at all, and it already carried a role saying it
  // fed nothing. A panel that is unverifiable, uncountable and uninformative has no
  // claim on the payload.
  //
  // The two capability panels that DO remain in the payload -- task-length horizons and
  // the GDPval comparisons -- are both drawn in the app, below the supplemental divider,
  // so a reader can check anything said about them.

  // Vintage last, so it covers every panel above without each one remembering.
  return attachVintage(panels, extras.todayYm ?? new Date().toISOString().slice(0, 7));
}
