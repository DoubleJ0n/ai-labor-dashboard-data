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
export const TRAILING_WINDOW = 120; // trailing 10-year baseline (readings)
export const WATCH_MIN_HISTORY = 36; // readings before a z-score is trustworthy

// --- COVID exclusion (mirrors Calibration.DEFAULT) — the ONE exclusion ---
export const COVID_START = "2020-01";
export const COVID_END = "2021-12";

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
export const LABOR_SHARE_BASELINE_QUARTERS = 120; // trailing 30 years

// --- Trend-direction parameters (finding 21: previously duplicated inline) ---
export const TREND_DRIFT_Z = 0.3; // z-drift beyond which a streak is moving, not flat
export const TREND_LOOKBACK_READINGS = 4; // readings compared for the drift

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
