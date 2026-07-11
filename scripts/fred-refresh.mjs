// Designed with Claude (Anthropic)
// fred-refresh: pulls the 8 FRED series the dashboard consumes (last 10
// years) and rewrites ONLY the "fred" section of dashboard-data.json.
// Free API; runs weekly via GitHub Actions. Key from FRED_API_KEY.
import { loadPool, saveSection, nowIso } from "./lib.mjs";

// Mirrors the app's domain/Models.kt SeriesIds.ALL — do not rename.
const SERIES_IDS = [
  "GDPC1", "PAYEMS", "USINFO", "TEMPHELPS",
  "CES6054150001", "CGBD2024", "LNS14000036", "UNRATE",
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
for (const id of SERIES_IDS) {
  series[id] = await fetchSeries(id);
  console.log(`${id}: ${series[id].length} observations`);
  if (series[id].length === 0) throw new Error(`FRED returned no data for ${id}`);
}

const prior = loadPool().fred;
saveSection("fred", { ...prior, lastRefreshed: nowIso(), series });
console.log("fred section updated");
