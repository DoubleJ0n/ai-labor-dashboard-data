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
// BACKLOG-3(a): AI adoption by firm employment-size class. Same BTOS survey, a
// different published workbook. Note the SPACES in the filename (url-encoded).
// Discovering this file was the work: the BTOS data page is a JS app with no
// links and every wrong filename returns HTTP 200 with an identical ~4.6 KB
// soft-404, so a "real file" check must test CONTENT, not status. Verified name
// came from the data tool's own bundle (census.gov/hfp/btos/js/app.*.js).
const SIZE_URL = "https://www.census.gov/hfp/btos/downloads/Employment%20Size%20Class.xlsx";
const SHEET = "Response Estimates";
// Size classes we plot: A = 1–4 employees (smallest), G = 250+ (largest). The
// gap between them is the point — big-employer adoption bears most on displacement.
const SIZE_SMALLEST = "A";
const SIZE_LARGEST = "G";

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

/**
 * Extract the AI current-use "Yes" series for one firm employment-size class from
 * the Employment Size Class workbook. Same sheet/columns as National.xlsx but with
 * a LEADING "Empsize" column, so cycle codes start one column later (index 5).
 * Deterministic + fail-loud, matching this script's robustness rule.
 */
function extractSizeSeries(rows, header, empsize, label) {
  const cycleCodes = header.slice(5); // shifted by the Empsize column
  const row = rows.find(
    (r) =>
      String(r[0]).trim().toUpperCase() === empsize &&
      /use Artificial Intelligence/i.test(String(r[2] ?? "")) &&
      /business functions/i.test(String(r[2] ?? "")) &&
      !/next six months/i.test(String(r[2] ?? "")) &&
      String(r[4]).trim().toLowerCase() === "yes",
  );
  if (!row) fail(`size class '${empsize}' AI 'Yes' row not found (structure changed?)`);
  const byMonth = new Map();
  cycleCodes.forEach((code, i) => {
    const raw = row[5 + i];
    if (raw == null) return;
    const pct = parseFloat(String(raw).replace("%", "").trim());
    if (!Number.isFinite(pct)) return; // "." = uncollected cycle (e.g. 202521–202523); missing, never zero
    const month = cycleToMonth(code);
    if (!month) return;
    if (!byMonth.has(month)) byMonth.set(month, pct); // codes descend L→R → keep latest cycle per month
  });
  const points = [...byMonth.entries()]
    .map(([date, pct]) => ({ date, pct }))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (points.length < 5) fail(`size class '${empsize}': only ${points.length} points — extraction looks wrong`);
  const oob = points.filter((p) => p.pct < 0 || p.pct > 100);
  if (oob.length) fail(`size class '${empsize}' values out of [0,100]: ${JSON.stringify(oob.slice(0, 3))}`);
  return { label, points };
}

/** Fetch + parse the size-class workbook; returns the bySize block. Fail-loud. */
async function fetchBySize() {
  const r = await fetch(SIZE_URL).catch((e) => fail(`size-class download threw: ${e.message ?? e}`));
  if (!r.ok) fail(`size-class download HTTP ${r.status}`);
  const b = Buffer.from(await r.arrayBuffer());
  // Content check, not status: the soft-404 is a tiny HTML page, not a zip.
  if (b.length < 50000 || b[0] !== 0x50 || b[1] !== 0x4b) fail(`size-class file is not a real xlsx (${b.length} bytes) — soft-404?`);
  let wb;
  try {
    wb = XLSX.read(b, { type: "buffer" });
  } catch (e) {
    fail(`size-class xlsx did not parse: ${e.message ?? e}`);
  }
  if (!wb.Sheets[SHEET]) fail(`size-class sheet '${SHEET}' missing`);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[SHEET], { header: 1, raw: false, defval: null });
  const header = rows[0] ?? [];
  // INVARIANT: leading Empsize column + the familiar Question/Answer columns.
  if (
    String(header[0]).trim() !== "Empsize" ||
    String(header[1]).trim() !== "Question ID" ||
    String(header[4]).trim() !== "Answer"
  ) {
    fail(`size-class header changed: ${JSON.stringify(header.slice(0, 5))}`);
  }
  const smallest = extractSizeSeries(rows, header, SIZE_SMALLEST, "1–4 employees");
  const largest = extractSizeSeries(rows, header, SIZE_LARGEST, "250+ employees");
  // INVARIANT: big employers adopt at least as much as the smallest at the latest
  // shared reading. A flip means a row/column mixup, not real data.
  const lgLatest = largest.points[largest.points.length - 1].pct;
  const smLatest = smallest.points[smallest.points.length - 1].pct;
  if (lgLatest < smLatest) fail(`largest (${lgLatest}%) below smallest (${smLatest}%) — likely a row/column mixup`);
  return {
    source: "US Census Bureau, BTOS Employment Size Class.xlsx — AI use in any business function (Yes), by firm employment-size class",
    sourceUrl: SIZE_URL,
    note:
      "Share of firms using AI in any business function, split by employment size (1–4 vs 250+ staff). " +
      "Context only — big-employer adoption bears most on displacement, but the RED gate stays on the all-firms share. " +
      "Cycles 202521–202523 (Oct–Nov 2025) were uncollected (funding lapse) and appear as gaps, never zero.",
    smallest,
    largest,
  };
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

// BACKLOG-3(a): pull the size-class split from the second BTOS workbook.
const bySize = await fetchBySize();

const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
const before = JSON.stringify({ points: snapshot.points ?? [], bySize: snapshot.bySize ?? null });
const latest = points[points.length - 1];

snapshot.points = points;
snapshot.bySize = bySize;
snapshot.lastRefreshed = new Date().toISOString().slice(0, 10);
snapshot.question = "In the last two weeks, did this business use Artificial Intelligence (AI) in any of its business functions? — Yes";
snapshot.note =
  "Live from the Census BTOS National.xlsx (share of firms using AI in ANY business function). " +
  "Broader than the older 'producing goods/services' supplement. Parsed with deterministic invariants.";

if (JSON.stringify({ points: snapshot.points, bySize: snapshot.bySize }) === before) {
  setOutput("status", "nochange");
  console.log("adoption: no change");
  process.exit(0);
}
writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2) + "\n");

const bigLatest = bySize.largest.points[bySize.largest.points.length - 1];
const smallLatest = bySize.smallest.points[bySize.smallest.points.length - 1];
const title = `adoption: AI use at ${latest.pct}% (${latest.date.slice(0, 7)})`;
writeFileSync(
  REPORT_PATH,
  [
    `# ${title}`,
    "",
    `Census BTOS national AI-use (any business function, Yes). ${points.length} monthly points.`,
    `Latest: **${latest.pct}%** as of ${latest.date.slice(0, 7)}.`,
    "",
    `By firm size (Employment Size Class.xlsx): largest (250+) **${bigLatest.pct}%** vs smallest (1–4) **${smallLatest.pct}%** as of ${bigLatest.date.slice(0, 7)}.`,
    "",
    `Sources: ${FEED_URL} · ${SIZE_URL}`,
  ].join("\n") + "\n",
);
setOutput("status", "changes");
setOutput("title", title);
console.log(title);
