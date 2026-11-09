// Designed with Claude (Anthropic)
// postings-refresh: pulls Indeed Hiring Lab's US Job Postings Tracker (by
// occupational sector, CC BY 4.0) and updates the exposed-vs-control job-postings
// spread. Firms stop ADVERTISING roles before they stop filling them, so postings
// lead headcount; the SPREAD (AI-exposed knowledge work minus hands-on control),
// not the level, is the signal — the whole index fell from its 2022 peak across
// the board.
//
// FREE (public CSV, no key, no model). Mechanical index like FRED, so it
// AUTO-COMMITS on change (the workflow commits data/postings/job_postings.json).
// Deterministic invariants FAIL LOUD on any upstream restructure (missing sector,
// missing variable) rather than silently mis-computing.
import { fetchWithRetry } from "./lib.mjs";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const CSV_URL =
  "https://raw.githubusercontent.com/hiring-lab/job_postings_tracker/master/US/job_postings_by_sector_US.csv";
const VARIABLE = "total postings";

// Occupational cuts (Indeed's normalized-title sectors). Construction/driving are
// not distinct Indeed cuts — mapped to their nearest hands-on sectors.
const EXPOSED = ["Software Development", "Data & Analytics", "Marketing", "Administrative Assistance"];
const CONTROL = ["Nursing", "Installation & Maintenance", "Loading & Stocking", "Food Preparation & Service"];
const ALL = [...EXPOSED, ...CONTROL];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SNAPSHOT_PATH = path.join(repoRoot, "data", "postings", "job_postings.json");

function fail(msg) { console.error(`postings-refresh FATAL: ${msg}`); process.exit(1); }

/** Split a CSV line where the first four fields are simple and the rest is display_name. */
function parseRow(line) {
  const parts = line.split(",");
  if (parts.length < 5) return null;
  const date = parts[0].trim();
  const index = parseFloat(parts[2]);
  const variable = parts[3].trim();
  const sector = parts.slice(4).join(",").trim().replace(/^"|"$/g, "");
  return { date, index, variable, sector };
}

// A RATE LIMIT IS NOT A BROKEN FEED. This was one unretried fetch, so a single 429
// from raw.githubusercontent.com — which serves this CSV to the whole internet and
// throttles by source IP, i.e. by GitHub Actions runner, not by us — ended the job
// red and left the panel a week stale. That is a transient condition being reported
// as a data failure, and it fires often enough to teach you to ignore red runs, which
// is the expensive part.
//
// So: retry the transient statuses, and keep failing loudly on everything else. A 404
// or a restructured feed is still a real problem and still stops the job on the first
// response. Only 429 and 5xx (plus network throws) are worth a second ask.
// The retry table and loop that used to live here are now fetchWithRetry in lib.mjs,
// so every job gets this behaviour instead of just this one. The reasoning above is
// unchanged and is the reason the helper exists.
async function fetchCsv() {
  try {
    const response = await fetchWithRetry(CSV_URL, {
      label: "postings CSV",
      init: { headers: { "user-agent": "ai-labor-dashboard-data/1.0 (+https://github.com/DoubleJ0n/ai-labor-dashboard-data)" } },
    });
    return response.text();
  } catch (e) {
    // The helper throws; this job reports through fail(), which prints the
    // "postings-refresh FATAL:" line the logs are read for. Keep that, rather than
    // letting an unhandled rejection dump a stack trace where a sentence used to be.
    fail(e.message ?? String(e));
  }
}

const text = await fetchCsv();

const lines = text.split("\n");
const header = lines[0].toLowerCase();
if (!header.includes("date") || !header.includes("variable") || !header.includes("display_name")) {
  fail(`unexpected header (upstream restructured?): ${lines[0]}`);
}

// sector+month -> last (chronological) index value; the CSV is date-ascending.
const byKey = new Map();
const monthsSeen = new Set();
const sectorsSeen = new Set();
let sawVariable = false;
for (let i = 1; i < lines.length; i++) {
  const row = parseRow(lines[i]);
  if (!row || !Number.isFinite(row.index)) continue;
  if (row.variable === VARIABLE) sawVariable = true;
  if (row.variable !== VARIABLE || !ALL.includes(row.sector)) continue;
  sectorsSeen.add(row.sector);
  const month = row.date.slice(0, 7); // YYYY-MM
  monthsSeen.add(month);
  byKey.set(`${row.sector}\u0000${month}`, row.index);
}

// INVARIANTS — fail loud on upstream drift.
if (!sawVariable) fail(`variable "${VARIABLE}" not found (upstream renamed it?)`);
const missing = ALL.filter((s) => !sectorsSeen.has(s));
if (missing.length) fail(`missing sectors (upstream renamed/removed?): [${missing.join(", ")}]`);

const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
const round1 = (v) => Math.round(v * 10) / 10;

const points = [];
for (const month of [...monthsSeen].sort()) {
  const ex = EXPOSED.map((s) => byKey.get(`${s}\u0000${month}`)).filter(Number.isFinite);
  const co = CONTROL.map((s) => byKey.get(`${s}\u0000${month}`)).filter(Number.isFinite);
  if (ex.length !== EXPOSED.length || co.length !== CONTROL.length) continue; // need all sectors
  const exposed = round1(avg(ex));
  const control = round1(avg(co));
  points.push({ date: `${month}-01`, exposed, control, spread: round1(exposed - control) });
}
if (points.length < 24) fail(`only ${points.length} monthly points parsed — expected the full history`);

mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
let snapshot;
try {
  snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
} catch {
  snapshot = {
    schemaVersion: 1,
    source: "Indeed Hiring Lab — Job Postings Tracker (US), by occupational sector",
    sourceUrl: "https://github.com/hiring-lab/job_postings_tracker",
    license: "CC BY 4.0 — data by Indeed Hiring Lab",
    variable: VARIABLE,
    exposedSectors: EXPOSED,
    controlSectors: CONTROL,
    note:
      "Exposed knowledge-work postings minus control hands-on postings; index = 100 at 2020-02-01. " +
      "Construction/driving map to the nearest available Indeed occupational cuts (Installation & Maintenance, Loading & Stocking). " +
      "The whole postings index fell from its 2022 peak across the board, so the SPREAD, not the level, is the signal.",
  };
}
const before = JSON.stringify(snapshot.points ?? []);
if (JSON.stringify(points) === before) {
  console.log("postings: no change");
  process.exit(0);
}
snapshot.exposedSectors = EXPOSED;
snapshot.controlSectors = CONTROL;
snapshot.points = points;
snapshot.lastRefreshed = new Date().toISOString().slice(0, 10);
writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2) + "\n", "utf8");

const latest = points[points.length - 1];
console.log(`postings: ${points.length} months, latest spread ${latest.spread} (exposed ${latest.exposed} / control ${latest.control}, ${latest.date})`);
