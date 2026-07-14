// Designed with Claude (Anthropic)
// fred-refresh: pulls the 8 FRED series the dashboard consumes (last 10
// years) and rewrites ONLY the "fred" section of dashboard-data.json.
// Free API; runs weekly via GitHub Actions. Key from FRED_API_KEY.
import { loadPool, saveSection, nowIso } from "./lib.mjs";

// Core series the original panels depend on (mirrors SeriesIds.ALL) — a
// missing one FAILS the run loudly.
const REQUIRED_IDS = [
  "GDPC1", "PAYEMS", "USINFO", "TEMPHELPS",
  "CES6054150001", "CGBD2024", "LNS14000036", "UNRATE",
];

// v9.2 additions for the recession-robust indicator. OPTIONAL: a bad/renamed
// id is skipped with a warning and never breaks the core pool.
const OPTIONAL_IDS = [
  // exposed-vs-control industry employment (CES, SA, thousands)
  "USPBS", "USFIRE",              // exposed: professional & business svcs, finance
  "USCONS", "USLAH", "USEHS",     // control: construction, leisure/hosp, edu/health
  // exposed-vs-control WAGES: avg hourly earnings, all employees (CES, SA, $), same industries
  "CES5000000003", "CES6000000003", "CES5500000003", // exposed: information, prof&business, financial
  "CES2000000003", "CES7000000003", "CES6500000003", // control: construction, leisure/hosp, edu/health
  // distributional
  "PRS85006173",                  // nonfarm business labor share (quarterly)
  // JOLTS rates (total nonfarm + professional & business services)
  "JTSJOR", "JTSHIR", "JTSLDR",
  "JTS6000JOR", "JTS6000HIR", "JTS6000LDR",
  // macro-regime gate (daily)
  "DFII10", "T10Y2Y", "T10Y3M", "T10YIE",
];

const apiKey = process.env.FRED_API_KEY;
if (!apiKey) {
  console.error("FRED_API_KEY is not set");
  process.exit(1);
}

const start = new Date();
start.setFullYear(start.getFullYear() - 10);
const observationStart = start.toISOString().slice(0, 10);

async function fetchSeries(seriesId) {
  const url = new URL("https://api.stlouisfed.org/fred/series/observations");
  url.searchParams.set("series_id", seriesId);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("file_type", "json");
  url.searchParams.set("observation_start", observationStart);
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
