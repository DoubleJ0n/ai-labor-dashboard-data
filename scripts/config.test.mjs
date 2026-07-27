// Designed with Claude (Anthropic)
// Parity test (audit-2026-07 finding 9): asserts the live config module
// against registered-values.json, the registration record the app repo also
// mirrors. A drifted constant fails the pre-flight before any model call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as config from "./config.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const registered = JSON.parse(readFileSync(path.join(repoRoot, "registered-values.json"), "utf8"));

test("config.mjs matches registered-values.json", () => {
  assert.equal(config.WATCH_Z, registered.watchZ);
  assert.equal(config.BREAK_Z, registered.breakZ);
  assert.equal(config.WATCH_MIN_HISTORY, registered.watchMinHistory);
  assert.equal(config.BASELINE_START, registered.baselineStart);
  assert.equal(config.BASELINE_END, registered.baselineEnd);
  assert.equal(config.OBSERVATION_START, registered.observationStart);
  assert.equal(config.UNUSABLE_START, registered.unusableStart);
  assert.equal(config.UNUSABLE_END, registered.unusableEnd);
  assert.equal(config.BASELINE_MIN_READINGS, registered.baselineMinReadings);
  assert.equal(config.BASELINE_REQUIRED_START, registered.baselineRequiredStart);
  assert.equal(config.BASELINE_START_SLACK_MONTHS, registered.baselineStartSlackMonths);
  assert.equal(config.BASELINE_FETCH_START, registered.baselineFetchStart);
  assert.equal(config.REABSORPTION_CHANGE_MONTHS, registered.reabsorptionChangeMonths);
  assert.equal(config.REABSORPTION_FAST_CHANGE_MONTHS, registered.reabsorptionFastChangeMonths);
  assert.equal(config.ATTRIBUTION_AXIS_Z, registered.attributionAxisZ);
  assert.equal(config.REABSORPTION_AXIS_LINE, registered.reabsorptionAxisLine);
  assert.equal(config.EARLY_WARNING_EXPOSED_JOB_LOSS_PCT, registered.earlyWarningExposedJobLossPct);
  assert.equal(config.REABSORPTION_REFERENCE_YEAR, registered.reabsorptionReferenceYear);
  assert.deepEqual(config.REABSORPTION, registered.reabsorption);
  assert.equal(config.PROD_BAND_LOW, registered.prodBandLowPct);
  assert.equal(config.PROD_BAND_HIGH, registered.prodBandHighPct);
  assert.equal(config.PROD_BREAK_RUN_QUARTERS, registered.prodBreakRunQuarters);
  assert.equal(config.CHAIN_BREADTH_MIN, registered.chainBreadthMin);
  assert.equal(config.ADOPTION_RISING_LOOKBACK, registered.adoptionRisingLookback);
  assert.equal(config.DATA_INTEGRITY_MAX_STALE_MONTHS, registered.dataIntegrityMaxStaleMonths);
  assert.equal(config.HEAVY_REVISION_MAX_PP, registered.heavyRevisionMaxPp);
  assert.equal(config.LABOR_SHARE_CHANGE_QUARTERS, registered.laborShareChangeQuarters);
  assert.equal(config.TREND_DRIFT_Z, registered.trendDriftZ);
  assert.equal(config.TREND_LOOKBACK_READINGS, registered.trendLookbackReadings);
  assert.equal(config.INVERSION_TRAILING_WINDOW_MONTHS, registered.inversionTrailingWindowMonths);
  assert.equal(config.INVERSION_MIN_HISTORY_MONTHS, registered.inversionMinHistoryMonths);
  assert.equal(config.SECTOR_PEAK_WINDOW_START, registered.sectorPeakWindowStart);
  assert.equal(config.GDPVAL_POOL_VERSION, registered.gdpvalPoolVersion);
  assert.equal(config.GDPVAL_MIN_RECORDS, registered.gdpvalMinRecords);
  assert.deepEqual(config.GDPVAL_REQUIRED_LABS, registered.gdpvalRequiredLabs);
  assert.equal(config.ELO_SCALE, registered.eloScale);
  assert.deepEqual(config.DIFFERENTIALS, registered.differentials);
  assert.deepEqual(config.MACRO_SPREAD_IDS, registered.macroSpreadIds);
});

// The rolling window is retired, not renamed. A z-score computed against a
// window that moves with the data normalises the exact regime change this
// dashboard exists to detect, so reintroducing the constant must fail here
// rather than quietly restoring the old behaviour in one panel.
test("the rolling trailing window is gone and cannot come back", () => {
  assert.equal(config.TRAILING_WINDOW, undefined, "TRAILING_WINDOW was re-registered as a fixed window; see BASELINE_START/BASELINE_END");
  assert.equal(registered.trailingWindow, undefined);
  assert.equal(config.COVID_START, undefined, "COVID_START widened into UNUSABLE_START; the old 24-month window must not linger");
  assert.equal(config.COVID_END, undefined);
  assert.equal(config.LABOR_SHARE_BASELINE_QUARTERS, undefined, "Card 2 uses the fixed window now; a rolling-30-year constant must not survive");
  assert.equal(registered.laborShareBaselineQuarters, undefined);
});

// The bug this pins: nearly every panel is DERIVED (year-over-year, 12-month
// change, 4-quarter change), so fetching from the baseline start hands the
// derivation a series missing its first year and the baseline silently begins in
// 2011. A reading count cannot catch that — 108 readings still clears 36 — which is
// the whole reason acceptance moved to the start date.
test("the fetch starts a full year before the baseline, for derived series", () => {
  const [fy, fm] = config.BASELINE_FETCH_START.split("-").map(Number);
  const [by, bm] = config.BASELINE_START.split("-").map(Number);
  const lead = (by * 12 + bm) - (fy * 12 + fm);
  assert.ok(lead >= 12, `fetch lead is ${lead} months; a 12-month derivation needs at least 12`);
});

test("acceptance is the start date, and the slack only covers quarter-end dating", () => {
  assert.equal(config.BASELINE_REQUIRED_START, config.BASELINE_START);
  assert.ok(config.BASELINE_START_SLACK_MONTHS <= 3, "more than a quarter of slack is not quarter-end dating");
  // 2016-07..2019-12 is 42 monthly readings, so it CLEARS the count floor while
  // being the late-cycle top of one expansion. Recorded as a test so nobody
  // reintroduces the count as the acceptance test by arguing it is sufficient.
  assert.ok(42 >= config.BASELINE_MIN_READINGS, "the count floor is satisfiable by 2016-07..2019-12 alone");
});

test("every exempt panel states a reason", () => {
  for (const [panel, reason] of Object.entries(config.BASELINE_EXEMPT_PANELS)) {
    assert.ok(reason && reason.length > 40, `${panel} needs a real reason, not a placeholder`);
  }
});

test("the fast reabsorption horizon is shorter than the one that places the axis", () => {
  assert.ok(config.REABSORPTION_FAST_CHANGE_MONTHS < config.REABSORPTION_CHANGE_MONTHS);
});

test("the fixed baseline is pre-treatment and the periods do not overlap", () => {
  assert.ok(config.BASELINE_START < config.BASELINE_END);
  // The whole point: the baseline ends before the unusable window opens, and the
  // observation period starts after it closes. No reading is in two periods.
  assert.ok(config.BASELINE_END < config.UNUSABLE_START);
  assert.ok(config.UNUSABLE_END < config.OBSERVATION_START);
  // And the baseline contains no part of what it is used to judge.
  assert.ok(config.BASELINE_END < config.OBSERVATION_START);
});

test("VERDICT_CRITICAL_SERIES is the differentials plus the macro spreads", () => {
  assert.deepEqual(
    config.VERDICT_CRITICAL_SERIES,
    [
      ...registered.differentials.jobs.exposed,
      ...registered.differentials.jobs.control,
      ...registered.differentials.wages.exposed,
      ...registered.differentials.wages.control,
      ...registered.macroSpreadIds,
    ],
  );
});
