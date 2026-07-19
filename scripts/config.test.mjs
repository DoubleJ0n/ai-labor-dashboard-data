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
  assert.equal(config.TRAILING_WINDOW, registered.trailingWindow);
  assert.equal(config.WATCH_MIN_HISTORY, registered.watchMinHistory);
  assert.equal(config.COVID_START, registered.covidStart);
  assert.equal(config.COVID_END, registered.covidEnd);
  assert.equal(config.PROD_BAND_LOW, registered.prodBandLowPct);
  assert.equal(config.PROD_BAND_HIGH, registered.prodBandHighPct);
  assert.equal(config.PROD_BREAK_RUN_QUARTERS, registered.prodBreakRunQuarters);
  assert.equal(config.CHAIN_BREADTH_MIN, registered.chainBreadthMin);
  assert.equal(config.ADOPTION_RISING_LOOKBACK, registered.adoptionRisingLookback);
  assert.equal(config.DATA_INTEGRITY_MAX_STALE_MONTHS, registered.dataIntegrityMaxStaleMonths);
  assert.equal(config.HEAVY_REVISION_MAX_PP, registered.heavyRevisionMaxPp);
  assert.equal(config.LABOR_SHARE_CHANGE_QUARTERS, registered.laborShareChangeQuarters);
  assert.equal(config.LABOR_SHARE_BASELINE_QUARTERS, registered.laborShareBaselineQuarters);
  assert.equal(config.TREND_DRIFT_Z, registered.trendDriftZ);
  assert.equal(config.TREND_LOOKBACK_READINGS, registered.trendLookbackReadings);
  assert.equal(config.INVERSION_TRAILING_WINDOW_MONTHS, registered.inversionTrailingWindowMonths);
  assert.equal(config.INVERSION_MIN_HISTORY_MONTHS, registered.inversionMinHistoryMonths);
  assert.equal(config.SECTOR_PEAK_WINDOW_START, registered.sectorPeakWindowStart);
  assert.deepEqual(config.DIFFERENTIALS, registered.differentials);
  assert.deepEqual(config.MACRO_SPREAD_IDS, registered.macroSpreadIds);
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
