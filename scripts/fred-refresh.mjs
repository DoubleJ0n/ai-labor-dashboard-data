// Designed with Claude (Anthropic)
// fred-refresh: pulls the 8 FRED series the dashboard consumes (last 10
// years) and rewrites ONLY the "fred" section of dashboard-data.json.
// Free API; runs weekly via GitHub Actions. Key from FRED_API_KEY.
import { loadPool, saveSection, nowIso } from "./lib.mjs";
import {
  DIFFERENTIALS, MACRO_SPREAD_IDS, REABSORPTION, BASELINE_START,
} from "./config.mjs";

// Core series the original panels depend on (mirrors SeriesIds.ALL) — a
// missing one FAILS the run loudly.
const REQUIRED_IDS = [
  "GDPC1", "PAYEMS", "USINFO", "TEMPHELPS",
  "CES6054150001", "CGBD2024", "LNS14000036", "UNRATE",
  // Productivity Break Test — output per HOUR, which is what the 2.7/3.4 band
  // was calibrated on. PRS85006091 is the PUBLISHED year-over-year ("percent
  // change from quarter one year ago") and is what the panel plots. Do NOT
  // swap in PRS85006092: that is "percent change at annual rate" (q/q), which
  // swings far wider and would trip the 3.4 line on quarterly noise.
  "PRS85006091",
  // OPHNFB is the index behind PRS85006091, pulled ONLY to cross-check it.
  "OPHNFB",
  // Worker share of income, Card 2 (audit-2026-07 finding 1 re-registration):
  // compensation of employees / gross domestic income — a true percent of
  // national income, quarterly, 1947-Q1+. REQUIRED because Card 2 is a
  // headline card: a missing input must fail loud, never render as benign.
  // The retired PRS85006173 (nonfarm-business labor share index) is gone
  // from every fetch list — the index and its display anchor no longer exist.
  "GDICOMP", "GDI",
];

// v9.2 additions for the recession-robust indicator. OPTIONAL: a bad/renamed
// id is skipped with a warning and never breaks the core pool. The
// differential taxonomy comes from config.mjs (audit-2026-07 finding 5) so
// the fetch list can never drift from the lists the verdict votes on.
// USINFO already sits in REQUIRED_IDS, so it is excluded here.
const OPTIONAL_IDS = [
  // exposed-vs-control industry employment (CES, SA, thousands)
  ...DIFFERENTIALS.jobs.exposed.filter((id) => !REQUIRED_IDS.includes(id)),
  ...DIFFERENTIALS.jobs.control,
  // exposed-vs-control WAGES: avg hourly earnings, all employees (CES, SA, $), same industries
  ...DIFFERENTIALS.wages.exposed,
  ...DIFFERENTIALS.wages.control,
  // The reabsorption axis: whether the outflow from exposed work landed
  // anywhere. Verified in CI before wiring; UNRATE (u3) is already required.
  ...Object.values(REABSORPTION).filter((id) => !REQUIRED_IDS.includes(id)),
  // macro-regime gate (daily)
  "DFII10", ...MACRO_SPREAD_IDS, "T10YIE",
];

// Series that get z-scored need the WHOLE fixed baseline window in the pool, and
// the rolling-10-year fetch did not reach it: the pool held exactly 120 monthly
// readings starting 2016-07, so the fixed 2010-2019 baseline was not merely
// mis-weighted, six of its ten years were absent. Fetching the baseline is a
// precondition for using it, and a short pull must fail loudly rather than
// silently score against a truncated window (see baselineCoverage below).
//
// Daily macro series are deliberately NOT in this set: the macro panel is a
// gate with no z-score, so pulling 16 years of daily yields would multiply the
// pool the app downloads for no statistical gain.
const FIXED_BASELINE_IDS = new Set([
  ...DIFFERENTIALS.jobs.exposed, ...DIFFERENTIALS.jobs.control,
  ...DIFFERENTIALS.wages.exposed, ...DIFFERENTIALS.wages.control,
  ...Object.values(REABSORPTION),
  "CGBD2024", "PRS85006091", "OPHNFB", "USINFO", "TEMPHELPS",
  "CES6054150001", "LNS14000036", "GDPC1", "PAYEMS",
]);

const apiKey = process.env.FRED_API_KEY;
if (!apiKey) {
  console.error("FRED_API_KEY is not set");
  process.exit(1);
}

// Default window for series that carry no z-score: still a rolling ten years,
// because for a gate or a chart that is plenty and the pool is a mobile download.
const start = new Date();
start.setFullYear(start.getFullYear() - 10);
const observationStart = start.toISOString().slice(0, 10);

// Series that ARE z-scored start at the fixed baseline instead. Derived from the
// registered constant so the fetch window can never drift from the window the
// statistics claim to use — the failure this replaces was exactly that drift.
const baselineFetchStart = `${BASELINE_START}-01`;

// A few series need a long history rather than either window above.
// Worker share: pull the FULL series back to 1947 — the multi-decade decline
// is itself the story, and the 4-quarter-change baseline wants the depth.
const LONG_HISTORY = { GDICOMP: "1947-01-01", GDI: "1947-01-01" };

const startFor = (id) =>
  LONG_HISTORY[id] ?? (FIXED_BASELINE_IDS.has(id) ? baselineFetchStart : observationStart);

async function fetchSeries(seriesId) {
  const url = new URL("https://api.stlouisfed.org/fred/series/observations");
  url.searchParams.set("series_id", seriesId);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("file_type", "json");
  url.searchParams.set("observation_start", startFor(seriesId));
  url.searchParams.set("sort_order", "asc");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FRED ${seriesId} HTTP ${res.status}`);
  const body = await res.json();
  // FRED marks missing values with "." — drop them (same as the app did).
  return (body.observations ?? [])
    .filter((o) => o.value !== ".")
    .map((o) => ({ date: o.date, value: Number(o.value) }));
}

const prior = loadPool().fred;

const series = {};
// Per-series gap markers (audit-2026-07 finding 2 / C-2): when an optional
// fetch fails, last week's copy is carried forward and the gap is RECORDED in
// the pool — a failed fetch must never leave a series silently absent while
// lastRefreshed claims the section is fresh. Downstream, absence of a
// verdict-critical series is a data-integrity CONFOUNDED, not a benign read.
const seriesGaps = {};

function carryForward(id, why) {
  const carried = prior.series?.[id];
  if (carried && carried.length > 0) {
    series[id] = carried;
    seriesGaps[id] = { carriedForwardFrom: prior.lastRefreshed ?? null, reason: why };
    console.warn(`${id}: ${why} — carried forward ${carried.length} observations from ${prior.lastRefreshed ?? "prior pool"}`);
  } else {
    seriesGaps[id] = { carriedForwardFrom: null, reason: `${why}; no prior copy to carry forward` };
    console.warn(`${id}: ${why} — no prior copy to carry forward, series absent`);
  }
}

for (const id of REQUIRED_IDS) {
  series[id] = await fetchSeries(id);
  console.log(`${id}: ${series[id].length} observations`);
  if (series[id].length === 0) throw new Error(`FRED returned no data for ${id}`);
}
for (const id of OPTIONAL_IDS) {
  try {
    const obs = await fetchSeries(id);
    if (obs.length > 0) {
      series[id] = obs;
      console.log(`${id}: ${obs.length} observations (optional)`);
    } else {
      carryForward(id, "fetch returned no data (optional)");
    }
  } catch (e) {
    carryForward(id, `fetch failed (optional): ${e.message ?? e}`);
  }
}

// How much of the fixed baseline each z-scored series actually has. Recorded in
// the pool rather than left implicit, because the spec's fallback rule ("where a
// series does not extend to 2010, use the longest available pre-2020 window and
// record the actual start date") is only honest if the actual start is written
// down somewhere a reader can check. A series with too few baseline readings is
// not silently scored against a stub — payload.mjs reports no clean baseline.
const baselineCoverage = {};
for (const id of FIXED_BASELINE_IDS) {
  const obs = series[id];
  if (!obs?.length) continue;
  const inWindow = obs.filter((o) => {
    const ym = o.date.slice(0, 7);
    return ym >= BASELINE_START && ym <= BASELINE_END;
  });
  baselineCoverage[id] = {
    baselineReadings: inWindow.length,
    actualBaselineStart: inWindow.length ? inWindow[0].date.slice(0, 7) : null,
    seriesStart: obs[0].date.slice(0, 7),
    // True when the series simply does not reach the registered window. Not an
    // error — postings and adoption genuinely postdate it — but it must travel.
    startsAfterBaseline: obs[0].date.slice(0, 7) > BASELINE_START,
  };
}
const thin = Object.entries(baselineCoverage).filter(([, c]) => c.baselineReadings < 36);
if (thin.length) {
  console.warn(
    `WARN ${thin.length} series have fewer than 36 readings inside the fixed baseline ` +
    `(${BASELINE_START}..${BASELINE_END}): ${thin.map(([id, c]) => `${id}=${c.baselineReadings}`).join(", ")}`,
  );
}

saveSection("fred", { ...prior, lastRefreshed: nowIso(), series, seriesGaps, baselineCoverage });
console.log(`fred section updated${Object.keys(seriesGaps).length ? ` (${Object.keys(seriesGaps).length} gap-marked series)` : ""}`);
console.log(`baseline coverage recorded for ${Object.keys(baselineCoverage).length} z-scored series`);
