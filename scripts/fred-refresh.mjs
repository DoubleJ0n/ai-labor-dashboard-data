// Designed with Claude (Anthropic)
// fred-refresh: pulls the 8 FRED series the dashboard consumes (last 10
// years) and rewrites ONLY the "fred" section of dashboard-data.json.
// Free API; runs weekly via GitHub Actions. Key from FRED_API_KEY.
import { loadPool, saveSection, nowIso } from "./lib.mjs";
import { DIFFERENTIALS, MACRO_SPREAD_IDS } from "./config.mjs";

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
  // macro-regime gate (daily)
  "DFII10", ...MACRO_SPREAD_IDS, "T10YIE",
];

const apiKey = process.env.FRED_API_KEY;
if (!apiKey) {
  console.error("FRED_API_KEY is not set");
  process.exit(1);
}

const start = new Date();
start.setFullYear(start.getFullYear() - 10);
const observationStart = start.toISOString().slice(0, 10);

// A few series need a long history rather than the default 10-year window.
// Worker share: pull the FULL series back to 1947 — the multi-decade decline
// is itself the story, and the 4-quarter-change baseline wants the depth.
const LONG_HISTORY = { GDICOMP: "1947-01-01", GDI: "1947-01-01" };

async function fetchSeries(seriesId) {
  const url = new URL("https://api.stlouisfed.org/fred/series/observations");
  url.searchParams.set("series_id", seriesId);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("file_type", "json");
  url.searchParams.set("observation_start", LONG_HISTORY[seriesId] ?? observationStart);
  url.searchParams.set("sort_order", "asc");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FRED ${seriesId} HTTP ${res.status}`);
  const body = await res.json();
  // FRED marks missing values with "." — drop them (same as the app did).
  return (body.observations ?? [])
    .filter((o) => o.value !== ".")
    .map((o) => ({ date: o.date, value: Number(o.value) }));
}

const series = {};
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
      console.warn(`${id}: no data (optional) — skipped`);
    }
  } catch (e) {
    console.warn(`${id}: fetch failed (optional) — skipped: ${e.message ?? e}`);
  }
}

const prior = loadPool().fred;
saveSection("fred", { ...prior, lastRefreshed: nowIso(), series });
console.log("fred section updated");
