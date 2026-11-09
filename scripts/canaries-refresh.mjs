// Designed with Claude (Anthropic)
// canaries-refresh: pulls the Stanford Digital Economy Lab / ADP Research "Canaries
// Dashboard" results and publishes the exposure-by-age employment index.
//
// WHY THIS PANEL EXISTS. Every other labour series on the dashboard is cut by INDUSTRY,
// which is a crude proxy for AI exposure (a janitor in the information sector counts as
// exposed). The reabsorption axis is economy-wide and not differenced on exposure at
// all, so an ordinary cycle moves it. status.md item 5 named the fix two years ago:
// young workers in AI-exposed OCCUPATIONS against young workers in non-exposed ones,
// which differences on both dimensions and cancels the cycle. That needed CPS microdata
// nobody had. Stanford and ADP now publish exactly that cut monthly from 4.6M payroll
// records, with a data dictionary, on a public bucket. This job reads it.
//
// FREE (public ZIPs, no key, no model). Mechanical like FRED: AUTO-COMMITS on change.
// Deterministic invariants FAIL LOUD on any upstream restructure (a renamed column, a
// changed quintile label, a moved normalization date) rather than silently mis-reading.
//
// WHAT IS READ, AND HOW THE SIDES ARE DEFINED.
//   exposed = quintiles 4 and 5 of occupational AI exposure (Eloundou et al. 2024)
//   control = quintiles 1, 2 and 3
// This is the paper's own grouping ("the two most exposed quintiles against the three
// least"), not a choice made here. Each side's index is the equal-weight mean of its
// quintiles' indices; the published quintile series already weight occupations
// equally, so this is a mean of means and is documented as such in the snapshot note.
//
// The year-over-year file is Stanford's, not recomputed here: the gap published per
// band is mean(yoy of Q4,Q5) minus mean(yoy of Q1..Q3), in percentage points.
//
// NO BASELINE. The series starts 2021-10 and there is no 2010-2019 window to score
// against, so this panel carries no z-score and no registered threshold. The gap is
// shown against zero. Where a line gets drawn is a judgement the maintainer registers,
// not something this script decides.
//
// REVISIONS. The sample is a rolling five-year balanced panel of ADP firms, so history
// revises every vintage. The vintage is stored with every refresh for that reason.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { fetchWithRetry } from "./lib.mjs";

const BUCKET = "https://storage.googleapis.com/aviary-del-public/release_memos/latest/downloads/";
const DASHBOARD_URL = "https://digitaleconomy.stanford.edu/project/indicators/canaries-dashboard/";
const AGE_PACKAGE = "canaries_age_by_exposure_results.zip";
const ALL_AGES_PACKAGE = "canaries_by_exposure_results.zip";

const EXPOSED_QUINTILES = ["Quintile 4", "Quintile 5 (most exposed)"];
const CONTROL_QUINTILES = ["Quintile 1 (least exposed)", "Quintile 2", "Quintile 3"];
const ALL_QUINTILES = [...CONTROL_QUINTILES, ...EXPOSED_QUINTILES];

// Upstream column label -> the short key the app reads. The labels are asserted against
// the data dictionary below, so a renamed band stops the job rather than vanishing.
const AGE_BANDS = {
  "Early Career 1 (22-25)": "22-25",
  "Early Career 2 (26-30)": "26-30",
  "Developing (31-34)": "31-34",
  "Mid-Career 1 (35-40)": "35-40",
  "Mid-Career 2 (41-49)": "41-49",
  "Senior (50+)": "50+",
};
const HEADLINE_BAND = "22-25";
const COMPARATOR_BAND = "50+";
const NORMALIZATION_DATE = "2022-11-01";
const MIN_MONTHS = 24;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SNAPSHOT_PATH = path.join(repoRoot, "data", "canaries", "canaries.json");

function fail(msg) { console.error(`canaries-refresh FATAL: ${msg}`); process.exit(1); }

// --- A minimal ZIP reader -------------------------------------------------------
// The packages are ordinary deflate ZIPs of four small files. Node has no ZIP support
// of its own, and pulling a dependency (or shelling out to `unzip`) for forty lines of
// well-specified format is the wrong trade for a job whose other failure modes are all
// about upstream files quietly changing shape. This reads the central directory and
// inflates each entry; anything it does not understand fails loud.
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a ZIP archive (no end-of-central-directory record)");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error("ZIP central directory is corrupt");
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error(`ZIP local header missing for ${name}`);
    const dataStart = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
    const data = buf.subarray(dataStart, dataStart + compSize);
    if (method === 0) files[name] = Buffer.from(data);
    else if (method === 8) files[name] = inflateRawSync(data);
    else throw new Error(`ZIP entry ${name} uses unsupported compression method ${method}`);
    off += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

/** RFC-4180-ish CSV: quoted fields, doubled quotes, CRLF tolerant. Returns rows of strings. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ""));
}

function toObjects(rows, label) {
  if (rows.length < 2) fail(`${label}: no data rows`);
  const header = rows[0].map((h) => h.replace(/^﻿/, "").trim());
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()])));
}

async function download(name) {
  const res = await fetchWithRetry(BUCKET + name, {
    label: `canaries ${name}`,
    init: { headers: { "user-agent": "ai-labor-dashboard-data/1.0 (+https://github.com/DoubleJ0n/ai-labor-dashboard-data)" } },
  });
  const etag = res.headers.get("etag");
  const lastModified = res.headers.get("last-modified");
  return { files: unzip(Buffer.from(await res.arrayBuffer())), etag, lastModified };
}

const num = (s) => (s === "" || s == null ? null : Number(s));
const round2 = (v) => Math.round(v * 100) / 100;
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

// --- Fetch --------------------------------------------------------------------
let age, allAges;
try {
  age = await download(AGE_PACKAGE);
  allAges = await download(ALL_AGES_PACKAGE);
} catch (e) {
  fail(e.message ?? String(e));
}

const need = (files, name) => {
  const f = files[name];
  if (!f) fail(`package is missing ${name} (upstream restructured? entries: ${Object.keys(files).join(", ")})`);
  return f.toString("utf8");
};

// --- The data dictionary is the contract. Assert against it, not around it. ----
const dictionary = need(age.files, "canaries_age_by_exposure_data_dictionary.md");
for (const q of ALL_QUINTILES) {
  if (!dictionary.includes(`\`${q}\``)) fail(`data dictionary no longer names quintile "${q}"`);
}
for (const band of Object.keys(AGE_BANDS)) {
  if (!dictionary.includes(`\`${band}\``)) fail(`data dictionary no longer names age band "${band}"`);
}
if (!dictionary.includes(`\`${NORMALIZATION_DATE}\``)) {
  fail(`data dictionary no longer states the normalization date ${NORMALIZATION_DATE}; the index base moved`);
}

// --- Read the three CSVs -------------------------------------------------------
const indexRows = toObjects(parseCsv(need(age.files, "canaries_age_by_exposure.csv")), "age index");
const yoyRows = toObjects(parseCsv(need(age.files, "canaries_age_by_exposure_yoy_change.csv")), "age yoy");
const allRows = toObjects(parseCsv(need(allAges.files, "canaries_by_exposure.csv")), "all-ages index");

const requiredCols = ["observation_date", "exposure_quintile", ...Object.keys(AGE_BANDS), "vintage"];
for (const col of requiredCols) {
  if (!(col in indexRows[0])) fail(`age index CSV lacks column "${col}"`);
  if (!(col in yoyRows[0])) fail(`age yoy CSV lacks column "${col}"`);
}
for (const q of ALL_QUINTILES) {
  if (!(q in allRows[0])) fail(`all-ages CSV lacks column "${q}"`);
}

const vintages = new Set([...indexRows, ...yoyRows].map((r) => r.vintage));
if (vintages.size !== 1) fail(`expected one vintage across the age files, found ${[...vintages].join(", ")}`);
const vintage = [...vintages][0];

// date -> quintile -> row
function byDateQuintile(rows, label) {
  const out = new Map();
  for (const r of rows) {
    if (!ALL_QUINTILES.includes(r.exposure_quintile)) fail(`${label}: unknown quintile label "${r.exposure_quintile}"`);
    if (!out.has(r.observation_date)) out.set(r.observation_date, new Map());
    out.get(r.observation_date).set(r.exposure_quintile, r);
  }
  return out;
}
const indexByDate = byDateQuintile(indexRows, "age index");
const yoyByDate = byDateQuintile(yoyRows, "age yoy");

/** Mean of one band's value across a side's quintiles; null if any is blank. */
function side(dateMap, quintiles, bandLabel, scale = 1) {
  const vals = quintiles.map((q) => num(dateMap.get(q)?.[bandLabel]));
  if (vals.some((v) => v == null || !Number.isFinite(v))) return null;
  return mean(vals) * scale;
}

const months = [];
for (const date of [...indexByDate.keys()].sort()) {
  const idx = indexByDate.get(date);
  if (idx.size !== ALL_QUINTILES.length) continue; // a partial month is not a month
  const yoy = yoyByDate.get(date);
  const index = {};
  const yoyGap = {};
  const yoyChange = {};
  for (const [label, key] of Object.entries(AGE_BANDS)) {
    const ex = side(idx, EXPOSED_QUINTILES, label);
    const co = side(idx, CONTROL_QUINTILES, label);
    index[key] = { exposed: ex == null ? null : round2(ex), control: co == null ? null : round2(co) };
    if (yoy && yoy.size === ALL_QUINTILES.length) {
      const yx = side(yoy, EXPOSED_QUINTILES, label, 100);
      const yc = side(yoy, CONTROL_QUINTILES, label, 100);
      yoyChange[key] = { exposed: yx == null ? null : round2(yx), control: yc == null ? null : round2(yc) };
      yoyGap[key] = yx == null || yc == null ? null : round2(yx - yc);
    } else {
      yoyChange[key] = { exposed: null, control: null };
      yoyGap[key] = null;
    }
  }
  months.push({ date, index, yoyChange, yoyGap });
}
if (months.length < MIN_MONTHS) fail(`only ${months.length} complete months parsed; expected at least ${MIN_MONTHS}`);

// All-ages index, exposed vs control, from the second package. Its own vintage is
// recorded separately: the gender section of the dashboard has lagged the headline
// before, and nothing says these two packages must always share a date.
const allAgesMonths = [];
for (const r of allRows.sort((a, b) => a.observation_date.localeCompare(b.observation_date))) {
  const ex = EXPOSED_QUINTILES.map((q) => num(r[q]));
  const co = CONTROL_QUINTILES.map((q) => num(r[q]));
  if ([...ex, ...co].some((v) => v == null || !Number.isFinite(v))) continue;
  allAgesMonths.push({ date: r.observation_date, exposed: round2(mean(ex)), control: round2(mean(co)) });
}
const allAgesVintage = allRows[0]?.vintage ?? null;

const latest = months[months.length - 1];
const anchor = months.find((m) => m.date === NORMALIZATION_DATE);
if (!anchor) fail(`the normalization month ${NORMALIZATION_DATE} is absent from the series`);
for (const key of Object.values(AGE_BANDS)) {
  // Every series is indexed to 100 at the anchor, so a mean of them is 100 there too.
  // A drift from 100 means the base moved or a column was mis-read.
  for (const s of ["exposed", "control"]) {
    const v = anchor.index[key][s];
    if (v == null || Math.abs(v - 100) > 0.05) fail(`index for ${key}/${s} is ${v} at the normalization month, expected 100`);
  }
}

// --- Write, only on change ----------------------------------------------------
mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
let snapshot;
try {
  snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
} catch {
  snapshot = { schemaVersion: 1 };
}
const next = {
  schemaVersion: 1,
  source: "Stanford Digital Economy Lab and ADP Research, AI Economic Indicators: Canaries Dashboard",
  sourceUrl: DASHBOARD_URL,
  dataUrl: BUCKET,
  citation: "Stanford Digital Economy Lab and ADP Research. \"AI Economic Indicators: Canaries Dashboard.\"",
  license: "No licence is stated by the publisher; the dashboard page gives a citation format and links general terms of use.",
  note:
    "Employment index by occupational AI-exposure quintile and age band, " +
    `${NORMALIZATION_DATE.slice(0, 7)} = 100, from anonymised ADP payroll records for a rolling ` +
    "five-year balanced panel of firms. Exposed = the two most exposed quintiles, control = the three " +
    "least, which is the paper's own grouping. Each side is the equal-weight mean of its quintile series. " +
    "The year-over-year figures are the publisher's, not recomputed. The sample is not representative " +
    "of the US labour market, occupations are weighted equally rather than by employment, and history " +
    "revises with every vintage. No pre-2020 history exists, so this panel carries no baseline z-score.",
  exposedQuintiles: EXPOSED_QUINTILES,
  controlQuintiles: CONTROL_QUINTILES,
  bands: Object.values(AGE_BANDS),
  headlineBand: HEADLINE_BAND,
  comparatorBand: COMPARATOR_BAND,
  normalizationDate: NORMALIZATION_DATE,
  vintage,
  allAgesVintage,
  sourceEtag: age.etag,
  sourceLastModified: age.lastModified,
  lastRefreshed: snapshot.lastRefreshed ?? null,
  months,
  allAges: allAgesMonths,
};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
if (snapshot.vintage === vintage && same(snapshot.months, months) && same(snapshot.allAges, allAgesMonths)) {
  console.log(`canaries: no change (vintage ${vintage}, latest month ${latest.date})`);
  process.exit(0);
}
next.lastRefreshed = new Date().toISOString().slice(0, 10);
writeFileSync(SNAPSHOT_PATH, JSON.stringify(next, null, 2) + "\n", "utf8");

const h = latest.yoyGap[HEADLINE_BAND];
const c = latest.yoyGap[COMPARATOR_BAND];
console.log(
  `canaries: ${months.length} months, vintage ${vintage}, latest ${latest.date}; ` +
  `yoy gap exposed-minus-control ${HEADLINE_BAND}: ${h} pts, ${COMPARATOR_BAND}: ${c} pts`,
);
