// Designed with Claude (Anthropic)
// adoption-refresh: pulls the Census BTOS national estimates spreadsheet and
// extracts the AI-adoption series ("In the last two weeks, did this business
// use Artificial Intelligence in any of its business functions?" -> Yes %),
// then PROPOSES an update to data/adoption/ai_adoption.json as a pull request.
//
// FREE (keyless xlsx download) — works without any API key or Anthropic credits.
//
// ROBUSTNESS: this is a fragile spreadsheet source, so detection is
// deterministic — strict INVARIANTS that FAIL LOUD if the sheet's shape
// changes, rather than silently mis-extracting. It never writes partial or
// implausible data. (An LLM repair path, if ever added, would be event-driven
// on an invariant failure — not a calendar timer.)
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as XLSX from "xlsx";

const FEED_URL = "https://www.census.gov/hfp/btos/downloads/National.xlsx";
const SHEET = "Response Estimates";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SNAPSHOT_PATH = path.join(repoRoot, "data", "adoption", "ai_adoption.json");
const REPORT_PATH = path.join(repoRoot, "adoption-refresh-report.md");

function fail(msg) {
  console.error(`adoption-refresh FATAL: ${msg}`);
  process.exit(1);
}
function setOutput(key, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}<<EOF\n${value}\nEOF\n`);
}

/** BTOS cycle code YYYYCC (CC = fortnight) -> first-of-month ISO date. */
function cycleToMonth(code) {
  const s = String(code);
  if (!/^\d{6}$/.test(s)) return null;
  const year = Number(s.slice(0, 4));
  const cc = Number(s.slice(4));
  if (cc < 1 || cc > 27) return null;
  // Fortnight cc ~ (cc-1)*14 days into the year; take the resulting month.
  const d = new Date(Date.UTC(year, 0, 1) + (cc - 1) * 14 * 86400000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

const res = await fetch(FEED_URL).catch((e) => fail(`download threw: ${e.message ?? e}`));
if (!res.ok) fail(`download HTTP ${res.status}`);
const buf = Buffer.from(await res.arrayBuffer());

let wb;
try {
  wb = XLSX.read(buf, { type: "buffer" });
} catch (e) {
  fail(`xlsx did not parse: ${e.message ?? e}`);
}
if (!wb.Sheets[SHEET]) fail(`sheet '${SHEET}' missing (upstream restructure?)`);
const rows = XLSX.utils.sheet_to_json(wb.Sheets[SHEET], { header: 1, raw: false, defval: null });

// INVARIANT: header row is the expected shape.
const header = rows[0] ?? [];
if (String(header[0]).trim() !== "Question ID" || String(header[3]).trim() !== "Answer") {
  fail(`unexpected header: ${JSON.stringify(header.slice(0, 4))}`);
}
const cycleCodes = header.slice(4);

// INVARIANT: find the AI current-use question + Yes answer by TEXT (robust to
// a changed Question ID), excluding the "next six months" future-use question.
const aiRow = rows.find(
  (r) =>
    /use Artificial Intelligence/i.test(String(r[1] ?? "")) &&
    /business functions/i.test(String(r[1] ?? "")) &&
    !/next six months/i.test(String(r[1] ?? "")) &&
    String(r[3]).trim().toLowerCase() === "yes",
);
if (!aiRow) fail("could not find the AI current-use 'Yes' row (question text changed?)");

// Extract (month, pct); "." / null are structural gaps (skipped).
const byMonth = new Map();
cycleCodes.forEach((code, i) => {
  const raw = aiRow[4 + i];
  if (raw == null) return;
  const pct = parseFloat(String(raw).replace("%", "").trim());
  if (!Number.isFinite(pct)) return;
  const month = cycleToMonth(code);
  if (!month) return;
  // Multiple cycles per month -> keep the latest cycle (codes descend L->R).
  if (!byMonth.has(month)) byMonth.set(month, pct);
});
const points = [...byMonth.entries()].map(([date, pct]) => ({ date, pct })).sort((a, b) => a.date.localeCompare(b.date));

// INVARIANTS on the extracted series.
if (points.length < 5) fail(`only ${points.length} usable points — extraction looks wrong`);
const bad = points.filter((p) => p.pct < 0 || p.pct > 100);
if (bad.length) fail(`values out of [0,100]: ${JSON.stringify(bad.slice(0, 3))} — wrong column?`);

const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
const before = JSON.stringify(snapshot.points ?? []);
const latest = points[points.length - 1];

snapshot.points = points;
snapshot.lastRefreshed = new Date().toISOString().slice(0, 10);
snapshot.question = "In the last two weeks, did this business use Artificial Intelligence (AI) in any of its business functions? — Yes";
snapshot.note =
  "Live from the Census BTOS National.xlsx (share of firms using AI in ANY business function). " +
  "Broader than the older 'producing goods/services' supplement. Parsed with deterministic invariants.";

if (JSON.stringify(snapshot.points) === before) {
  setOutput("status", "nochange");
  console.log("adoption: no change");
  process.exit(0);
}
writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2) + "\n");

const title = `adoption: AI use at ${latest.pct}% (${latest.date.slice(0, 7)})`;
writeFileSync(
  REPORT_PATH,
  [
    `# ${title}`,
    "",
    `Census BTOS national AI-use (any business function, Yes). ${points.length} monthly points.`,
    `Latest: **${latest.pct}%** as of ${latest.date.slice(0, 7)}.`,
    "",
    `Source: ${FEED_URL}`,
  ].join("\n") + "\n",
);
setOutput("status", "changes");
setOutput("title", title);
console.log(title);
