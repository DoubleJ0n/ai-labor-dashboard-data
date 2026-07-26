// Designed with Claude (Anthropic)
//
// config.mjs — the single registered home of every pre-registered value in
// the data repo (audit-2026-07 findings 5, 6, 7, 9, 21: these values were
// previously re-declared per file, and one live path had drifted).
//
// RULES
// - Every script imports from here; nothing re-declares a value below.
// - These mirror the app's registered constants (Metrics.kt, Watch.kt,
//   Verdicts.kt, Calibration.kt, SeriesIds.kt). config.test.mjs asserts this
//   file against registered-values.json, the cross-repo registration record.
// - Pre-registered, do-not-move: changing any value here is a public
//   re-registration, not maintenance.

// --- Statistical thresholds and windows (mirror Watch.kt) ---
export const WATCH_Z = 1.0; // amber: attention, not alarm
export const BREAK_Z = 2.0; // the one-in-twenty alarm line
export const WATCH_MIN_HISTORY = 36; // readings before a z-score is trustworthy

// --- The baseline window (re-registered 2026-07: FIXED, was rolling) ---
//
// This replaces the rolling TRAILING_WINDOW = 120 that every panel used to
// z-score against. The old window was not merely arbitrary, it was circular: on
// a pool holding exactly 120 monthly readings the "trailing 10-year baseline"
// WAS the entire dataset, and a majority of it sat inside the period the
// dashboard exists to evaluate. Post-treatment data was defining the control,
// so "inside its normal range" partly meant "consistent with the AI era."
//
// A rolling window also chases the trend it is supposed to detect: five years of
// steady deterioration re-centres the mean every month and reads as normal the
// whole way down. A displacement episode would be normalised as it happened.
//
// So the baseline is fixed and pre-treatment, and it never moves:
export const BASELINE_START = "2010-01"; // fixed baseline, never rolling
export const BASELINE_END = "2019-12";
export const OBSERVATION_START = "2023-01"; // what is being measured against it

// The unusable middle. WIDENED from the old COVID window (2020-01..2021-12) by
// twelve months, which is a public re-registration and not maintenance. 2022
// belongs in the hole for a different reason than 2020-21: the pandemic whipsaw
// inflated every standard deviation, while 2021-22 was the exposed-industry
// hiring overshoot whose unwind is the standing non-AI explanation on this
// dashboard. Leaving 2022 in a baseline lets the overshoot peak help define
// "normal", which is the same post-treatment error in a different costume.
export const UNUSABLE_START = "2020-01";
export const UNUSABLE_END = "2022-12";

// Minimum readings inside the FIXED window before its z is trustworthy. Monthly
// series get 120 readings from 2010-2019 and quarterly ones get 40, so both
// clear WATCH_MIN_HISTORY — but a series starting after 2010 (postings begins
// 2020-02, adoption 2025-11) can fail this, and that failure must surface as
// "no clean baseline exists" rather than as a quiet fallback to full history.
export const BASELINE_MIN_READINGS = WATCH_MIN_HISTORY;

// --- Productivity band (mirrors Metrics.kt; the 2.7/3.4 registration) ---
export const PROD_BAND_LOW = 2.7; // %/yr — above long baseline
export const PROD_BAND_HIGH = 3.4; // %/yr — the displacement tripwire
export const PROD_BREAK_RUN_QUARTERS = 2; // consecutive quarters above the band for BREAK

// --- Verdict-chain rule parameters (finding 7: previously inline literals) ---
export const CHAIN_BREADTH_MIN = 2; // voting differentials that must fire for BREAK
export const ADOPTION_RISING_LOOKBACK = 4; // readings back for the "rising" deployment gate
export const DATA_INTEGRITY_MAX_STALE_MONTHS = 3; // labor data older than this is unstable inputs

// --- Heavy-revision detection (finding 10: registered with its implementation) ---
// A logged month's jobs/wages differential moving by more than this many
// percentage points on a later re-read of the same reference month means the
// BLS inputs were heavily revised -> deterministic CONFOUNDED (pathway b).
export const HEAVY_REVISION_MAX_PP = 0.5;

// --- Worker share of income, Card 2 (finding 1 re-registration, 2026-07) ---
// Change in the GDICOMP/GDI share over LABOR_SHARE_CHANGE_QUARTERS quarters,
// z-scored against its trailing LABOR_SHARE_BASELINE_QUARTERS history of such
// changes, COVID-excluded, latest reading excluded from the baseline.
export const LABOR_SHARE_CHANGE_QUARTERS = 4;
// LABOR_SHARE_BASELINE_QUARTERS (trailing 30 years) is RETIRED 2026-07-26. Card 2
// now scores its 4-quarter changes against the same fixed 2010-2019 window as
// every other panel. Keeping a constant that promised a rolling thirty-year norm
// while the code used a fixed decade is precisely the drift this file prevents.
// For a quarterly series the fixed window is 40 readings, above the 36 minimum
// but not comfortably, and the payload reports the count so the thinness shows.

// --- Trend-direction parameters (finding 21: previously duplicated inline) ---
export const TREND_DRIFT_Z = 0.3; // z-drift beyond which a streak is moving, not flat
export const TREND_LOOKBACK_READINGS = 4; // readings compared for the drift

// --- GDPval-AA leaderboard (capability context; votes on nothing) ---
// Elo is frozen per index version and versions are NOT comparable (v1 topped by
// Opus 4.8 at 1890, v2 by Opus 5 at 1861). The upstream field name carries the
// version, so gdpval-refresh reads it from the data and fails when it differs
// from this registration — a pool roll is a public re-registration.
export const GDPVAL_POOL_VERSION = "v2";
export const GDPVAL_MIN_RECORDS = 50; // a smaller parse means the page changed shape
export const GDPVAL_REQUIRED_LABS = ["Anthropic", "OpenAI"]; // the per-lab chart needs both
// 400 Elo = 10:1 odds. The scale constant in the logistic, not a tunable.
export const ELO_SCALE = 400;

// --- Other registered windows ---
export const INVERSION_TRAILING_WINDOW_MONTHS = 120;
export const INVERSION_MIN_HISTORY_MONTHS = 36;
export const SECTOR_PEAK_WINDOW_START = "2021-01-01";

// --- The voting-differential taxonomy (finding 5: was declared three times).
// The identity of the three panels that decide the verdict. The app's
// SeriesIds groups are the acknowledged cross-repo mirror.
export const DIFFERENTIALS = {
  jobs: {
    // CES industry employment (SA, thousands)
    exposed: ["USINFO", "USPBS", "USFIRE"], // information, professional/business, financial
    control: ["USCONS", "USLAH", "USEHS"], // construction, leisure/hospitality, education/health
  },
  wages: {
    // CES average hourly earnings, all employees (SA, $), same industries
    exposed: ["CES5000000003", "CES6000000003", "CES5500000003"],
    control: ["CES2000000003", "CES7000000003", "CES6500000003"],
  },
};

// --- The reabsorption axis (new 2026-07) ---
//
// Why this exists: the exposed-vs-control gap cannot carry a displacement
// verdict, because it measures REALLOCATION. Work the mechanics — if AI
// eliminates 100 jobs in information and professional services and all 100 of
// those workers are hired in construction and health care, exposed employment
// falls, control employment rises, the gap widens from both ends at once, and
// total employment is unchanged with every worker landing somewhere. Perfect
// reallocation produces a maximally negative gap and zero net displacement.
//
// The gap is still necessary: it is the only thing on this dashboard that lets
// anything be attributed to AI-exposed work rather than to the general economy.
// But it is an ATTRIBUTION measure, and attribution is half the question. The
// missing half is whether the outflow landed anywhere, which is what these
// series ask. None of them requires knowing where any individual went.
//
// Every id below was verified against the FRED series endpoint in CI before
// being wired (the standing rule: an unverified series id never gets wired).
// Titles and ranges as returned 2026-07-26.
export const REABSORPTION = {
  // Employment-Population Ratio - 25-54 Yrs. (percent, SA, monthly, 1948-01+).
  // THE HEADLINE. Restricting to 25-54 strips the demographic drift that
  // contaminates the all-ages participation rate: retirements pull the headline
  // down for reasons that have nothing to do with anyone being displaced.
  primeAgeEpop: "LNS12300060",
  // Of Total Unemployed, Percent Unemployed 27 Weeks & over (percent, SA,
  // monthly, 1948-01+). Are exits failing to land.
  longTermUnemployedShare: "LNS13025703",
  // Hires: Total Nonfarm, rate (SA, monthly, 2000-12+). Absorption pace.
  hiresRate: "JTSHIR",
  // Quits: Total Nonfarm, rate (SA, monthly, 2000-12+). Shedding pace.
  quitsRate: "JTSQUR",
  // U-6 minus U-3: landing, but underemployed. UNRATE is already in the pool.
  u6: "U6RATE",
  u3: "UNRATE",
};

// The reabsorption axis reads the CHANGE in prime-age employment-population,
// not its level, z-scored against the distribution of like changes in the fixed
// window. This is not a stylistic choice. A level's 2010-2019 mean is
// trend-contaminated in a way a differential's is not: that decade OPENS in the
// post-financial-crisis hole and climbs for ten years, so its mean sits far
// below its own 2019 endpoint. Scoring today's level against it would read as
// "abnormally healthy" more or less permanently and the deterioration side of
// the axis would be close to unfireable. Card 2 already z-scores the 4-quarter
// CHANGE in the worker income share for exactly this reason; this follows it.
export const REABSORPTION_CHANGE_MONTHS = 12;

// --- The paired state (new 2026-07) ---
//
// Attribution and reabsorption are independent axes, and the pairing is the
// discriminator neither one is on its own:
//
//   gap widening + aggregate holding      -> REALLOCATION
//   gap widening + aggregate deteriorating -> DISPLACEMENT
//   gap flat     + aggregate deteriorating -> NOT_AI
//   gap flat     + aggregate holding       -> STABLE
//
// Both axis thresholds reuse the registered attention line rather than
// introducing a new tunable: an axis is "moving" when its fixed-baseline z
// reaches WATCH_Z in the displacement direction. One threshold, already
// registered, already mirrored in the app.
//
// This state is COMPUTED AND STORED, and it is never sent to the analyst. See
// analyst/pairedState.mjs for that boundary and why it is drawn there.
export const PAIRED_STATE_AXIS_Z = WATCH_Z;

// --- Macro-regime gate series (the recession-veto inputs) ---
export const MACRO_SPREAD_IDS = ["T10Y2Y", "T10Y3M"];

// Series the verdict cannot be derived without (finding 2): if any of these
// is absent from the pool, absence must read as "no data", never as benign.
export const VERDICT_CRITICAL_SERIES = [
  ...DIFFERENTIALS.jobs.exposed,
  ...DIFFERENTIALS.jobs.control,
  ...DIFFERENTIALS.wages.exposed,
  ...DIFFERENTIALS.wages.control,
  ...MACRO_SPREAD_IDS,
];
