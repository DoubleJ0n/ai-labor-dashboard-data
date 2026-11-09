// Designed with Claude (Anthropic)
// challenger-refresh: reads the Challenger, Gray & Christmas monthly Job Cuts Report and
// publishes announced US job cuts by stated reason, with the AI-attributed line.
//
// WHY THIS PANEL EXISTS. Every attribution measure on this dashboard INFERS an AI
// connection from a pattern: exposed industries against control industries, exposed
// occupations against the rest. This is the one series where attribution is STATED,
// by the employer, at the time of the announcement. That is a different kind of
// evidence with its own well-known weaknesses, and both the strength and the
// weaknesses are the reason to show it beside the inferred measures rather than
// instead of them.
//
// THE CAVEATS, STATED UP FRONT (and carried in the snapshot note):
//   - Announcements, not realised separations. A plan to cut 1,000 is logged at 1,000
//     whether or not 1,000 people leave.
//   - Self-reported reasons. "AI" is whatever the company said; Challenger itself
//     keeps a separate "Technological Update (possibly AI)" bucket for the ambiguous
//     cases, and that bucket is published here too.
//   - "AI-washing" cuts both ways: a firm may name AI to dress up a cost cut, or
//     avoid naming it to dodge a headline.
//   - AI has been tracked as a distinct reason only since 2023, so there is no
//     2010-2019 baseline and this panel carries no z-score. Descriptive; votes on
//     nothing.
//
// FREE (public PDF, no key, no model). Mechanical like FRED: AUTO-COMMITS on change.
// The report is one PDF a month, linked from the newest post in the "Job Cuts Report"
// category. Each PDF carries one month plus year-to-date, so the snapshot ACCUMULATES:
// a month once parsed is kept, and the daily run only looks for posts it has not seen.
// `--backfill <pages>` walks that many archive pages and parses every monthly PDF it
// finds, for the initial load.
//
// HOW THE TABLES ARE READ. The PDF is parsed with pdf.js (pure JavaScript, so the same
// code runs on the maintainer's machine and in Actions), which yields every text run
// with its position. Runs are grouped into rows by vertical position and columns are
// assigned by horizontal position against the table's own header. This matters: the
// report was redesigned in autumn 2026, and `pdftotext -layout` on the new design
// interleaves the label column and the number column three rows apart, so a parser
// reading text lines would have published the wrong figure on the right label. Rows
// are also matched by LABEL, never by counting numbers on a line.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { fetchWithRetry } from "./lib.mjs";

const CATEGORY_URL = "https://www.challengergray.com/blog/category/job-cuts-report/";
const UA = "Mozilla/5.0 (compatible; ai-labor-dashboard-data/1.0; +https://github.com/DoubleJ0n/ai-labor-dashboard-data)";
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SNAPSHOT_PATH = path.join(repoRoot, "data", "challenger", "job_cuts.json");

const args = process.argv.slice(2);
const backfillIdx = args.indexOf("--backfill");
const PAGES = backfillIdx >= 0 ? Number(args[backfillIdx + 1] ?? 1) : 1;
if (!Number.isInteger(PAGES) || PAGES < 1) { console.error("--backfill wants a positive page count"); process.exit(2); }

function fail(msg) { console.error(`challenger-refresh FATAL: ${msg}`); process.exit(1); }

async function fetchText(url, label) {
  const res = await fetchWithRetry(url, { label, init: { headers: { "user-agent": UA } } });
  return res.text();
}
async function fetchBytes(url, label) {
  const res = await fetchWithRetry(url, { label, init: { headers: { "user-agent": UA } } });
  return new Uint8Array(await res.arrayBuffer());
}

/** Post URLs on one archive page, in page order, excluding category and pagination links. */
function postLinks(html) {
  const seen = new Set();
  const out = [];
  for (const m of html.matchAll(/href="(https:\/\/www\.challengergray\.com\/blog\/[^"#?]+\/)"/g)) {
    const u = m[1];
    if (u.includes("/category/") || u.includes("/page/") || u === "https://www.challengergray.com/blog/") continue;
    if (!seen.has(u)) { seen.add(u); out.push(u); }
  }
  return out;
}

function pdfLink(html) {
  const m = html.match(/href="(https:\/\/www\.challengergray\.com\/wp-content\/uploads\/[^"]+\.pdf)"/i);
  return m ? m[1] : null;
}

// --- Positioned text ---------------------------------------------------------------

/**
 * Every page as rows of positioned runs: [{ page, y, items: [{x, w, s}], text }].
 * Rows are runs within 2.5 units vertically; items are left to right. `text` joins the
 * runs with single spaces.
 */
async function extractRows(bytes) {
  const doc = await getDocument({ data: bytes, useSystemFonts: true, isEvalSupported: false, disableFontFace: true }).promise;
  const rows = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const items = tc.items
        .filter((i) => i.str && i.str.trim())
        .map((i) => ({ x: i.transform[4], y: i.transform[5], w: i.width ?? 0, s: i.str.trim() }))
        .sort((a, b) => b.y - a.y || a.x - b.x);
      let cur = null;
      for (const it of items) {
        if (cur && Math.abs(cur.y - it.y) <= 2.5) cur.items.push(it);
        else { cur = { page: p, y: it.y, items: [it] }; rows.push(cur); }
      }
    }
  } finally {
    await doc.destroy();
  }
  for (const r of rows) {
    r.items.sort((a, b) => a.x - b.x);
    r.text = r.items.map((i) => i.s).join(" ");
  }
  return rows;
}

const toInt = (s) => (s == null ? null : Number(String(s).replace(/,/g, "")));
const isNumber = (s) => /^[\d,]+$/.test(s);
const centre = (it) => it.x + it.w / 2;
// Older reports come out of pdf.js with letters split by kerning ("Ju ly 2025",
// "F OR R ELEASE", "202 5"), so anything matched as a WORD is matched with the spaces
// removed and the case folded. Labels keep their spacing for display; only the
// comparison is despaced.
const despace = (s) => s.replace(/\s+/g, "").toLowerCase();
const MONTHS_DESPACED = MONTHS.map((m) => m.toLowerCase());
const MONTH_ALT = MONTHS_DESPACED.join("|");

/** Rows of one titled table: from the title row to the next "Source:" or "Table N:" row. */
function tableRows(rows, titleRe) {
  const start = rows.findIndex((r) => titleRe.test(r.text));
  if (start < 0) return null;
  const out = [];
  for (let i = start + 1; i < rows.length; i++) {
    const t = rows[i].text;
    if (/^Source:/i.test(t) || /^Table \d+:/i.test(t)) break;
    out.push(rows[i]);
  }
  return out;
}

/**
 * Split a row into its label (the non-numeric runs left of the first value column) and
 * its numbers, each assigned to the nearest column centre.
 */
/**
 * Numbers sometimes arrive split across adjacent runs ("153,07" "4"; "10" "," "300";
 * "1,170,8" "21"). Runs that are digits or commas and sit within a few units of each
 * other are one number. Real columns are tens of units apart, so they never merge.
 */
function mergeNumericRuns(items) {
  const out = [];
  for (const it of items) {
    const prev = out.at(-1);
    if (prev && /^[\d,]+$/.test(prev.s) && /^[\d,]+$/.test(it.s) && it.x - (prev.x + prev.w) <= 3) {
      out[out.length - 1] = { x: prev.x, y: prev.y, w: it.x + it.w - prev.x, s: prev.s + it.s };
    } else {
      out.push({ ...it });
    }
  }
  return out;
}

function readRow(row, columns) {
  const firstCol = Math.min(...columns.map((c) => c.x));
  const labelRuns = [];
  const values = {};
  for (const it of mergeNumericRuns(row.items)) {
    if (isNumber(it.s)) {
      let best = null;
      for (const c of columns) {
        const d = Math.abs(centre(it) - c.x);
        if (!best || d < best.d) best = { key: c.key, d };
      }
      values[best.key] = toInt(it.s);
    } else if (it.x < firstCol - 15) {
      labelRuns.push(it.s);
    }
  }
  // "Cost - Cutting" arrives as three runs; the publisher writes "Cost-Cutting".
  const label = labelRuns.join(" ").replace(/\s*-\s*/g, "-").replace(/\s+/g, " ").trim();
  return { label, values };
}

/**
 * The report month. First the title block (a row reading "<Month> <Year>" on page 1);
 * failing that, the reason table's own header ("Jan-26 ... YTD 2026"), which every
 * monthly report carries even when the cover page is laid out differently. A post
 * whose PDF has neither is not a monthly report.
 */
function reportMonth(rows) {
  for (const r of rows.filter((r) => r.page === 1).slice(0, 40)) {
    const m = despace(r.text).match(new RegExp(`^(${MONTH_ALT})(\\d{4})$`));
    if (m) return `${m[2]}-${String(MONTHS_DESPACED.indexOf(m[1]) + 1).padStart(2, "0")}`;
  }
  const table = tableRows(rows, /JOB CUTS BY REASON/i);
  if (!table) return null;
  for (const r of table) {
    // "jan-26ytd2026", "dec-252025" (bare current year), "jan-262025" (bare PRIOR year
    // on a January report). The month's own two-digit year is what decides.
    const t = despace(r.text).match(/^(?:reason)?([a-z]{3})-?(\d{2})(?:ytd)?(20\d{2})$/);
    if (!t) continue;
    const mi = MONTHS_DESPACED.findIndex((m) => m.startsWith(t[1]));
    if (mi < 0) continue;
    return `20${t[2]}-${String(mi + 1).padStart(2, "0")}`;
  }
  return null;
}

/** "FOR RELEASE AT 5:30 A.M. ET, THURSDAY, AUGUST 6, 2026" -> "2026-08-06". */
function releaseDate(rows) {
  const text = despace(rows.filter((r) => r.page === 1).map((r) => r.text).join("\n"));
  const m = text.match(new RegExp(`forrelease.{0,80}?(${MONTH_ALT})(\\d{1,2}),?(\\d{4})`));
  if (!m) return null;
  const mi = MONTHS_DESPACED.indexOf(m[1]);
  if (mi < 0) return null;
  return `${m[3]}-${String(mi + 1).padStart(2, "0")}-${String(m[2]).padStart(2, "0")}`;
}

/**
 * Table 4, JOB CUTS BY REASON. Header: "Reason  <Mon>-<yy>  YTD <year>". Either value
 * may be absent on a row; the position decides which one is present.
 */
function parseReasons(rows, reportYear) {
  const table = tableRows(rows, /JOB CUTS BY REASON/i);
  if (!table) return null;
  // The header carries a month abbreviation and "YTD <year>". It may or may not carry
  // the word "Reason" (the 2025 design did not), and the month may arrive as one run
  // ("Jul-26") or several ("Oct", "-", "26").
  const isMonthRun = (i) => /^[A-Za-z]{3}(-\d{2})?$/.test(i.s)
    && MONTHS_DESPACED.some((m) => m.startsWith(i.s.slice(0, 3).toLowerCase()));
  // The second column is "YTD <year>" on most reports. On a January report it is the
  // PRIOR full year ("Jan-26  2025"), a comparison rather than a year-to-date, and
  // year-to-date is then the month itself. On the December report it is the bare
  // current year, which IS the year-to-date.
  // Some reports add a third column ("Feb-26  YTD 2026  Full Year 2025"), so EVERY
  // header group from the month column rightwards becomes a column, and each number
  // goes to the nearest one. Two columns read as before; a third stops swallowing the
  // year-to-date figure.
  const isYtdRun = (i) => /^YTD/i.test(i.s);
  const isYearRun = (i) => /^20\d{2}$/.test(i.s);
  const hi = table.findIndex((r) => r.items.some(isMonthRun) && (r.items.some(isYtdRun) || r.items.some(isYearRun)));
  if (hi < 0) return null;
  const header = table[hi];
  const monthRun = header.items.find(isMonthRun);
  if (!monthRun) return null;
  const groups = [];
  for (const it of header.items.filter((i) => i.x >= monthRun.x - 1)) {
    const g = groups.at(-1);
    if (g && it.x - (g.last.x + g.last.w) <= 8) { g.items.push(it); g.last = it; }
    else groups.push({ items: [it], last: it });
  }
  const columns = groups.map((g, n) => {
    const text = despace(g.items.map((i) => i.s).join(""));
    const year = text.match(/(20\d{2})$/)?.[1];
    const kind = g.items.some(isMonthRun) && n === 0 ? "month"
      : /^ytd/.test(text) || (year && Number(year) === reportYear && !/fullyear/.test(text)) ? "ytd"
      : "other";
    return { key: `${kind}${n}`, kind, x: (g.items[0].x + g.last.x + g.last.w) / 2 };
  });
  const monthKey = columns.find((c) => c.kind === "month")?.key;
  const ytdKey = columns.find((c) => c.kind === "ytd")?.key;
  if (!monthKey) return null;
  const out = {};
  for (const r of table.slice(hi + 1)) {
    const { label, values } = readRow(r, columns);
    if (!label) continue;
    const month = values[monthKey] ?? null;
    // With no year-to-date column (a January report compared against the prior full
    // year), the month is the year to date.
    out[label] = { month, ytd: ytdKey ? (values[ytdKey] ?? null) : month };
  }
  return out;
}

/**
 * Table 1, MONTH BY MONTH TOTALS: a header of two years, then "<Month> <this> <last>"
 * rows and a TOTAL row. Returns this year's figure per month and the TOTAL row.
 */
function parseMonthlyTotals(rows) {
  const table = tableRows(rows, /MONTH BY MONTH TOTALS/i);
  if (!table) return null;
  const isYear = (i) => /^20\d{2}$/.test(i.s);
  const header = table.find((r) => r.items.filter(isYear).length >= 2);
  if (!header) return null;
  const years = header.items.filter(isYear).map((i) => ({ key: i.s, x: centre(i) }));
  const [y1, y2] = years.map((y) => Number(y.key));
  const thisYear = {};
  const lastYear = {};
  let total = null;
  for (const r of table) {
    const { label, values } = readRow(r, years);
    const key = despace(label);
    const mi = MONTHS_DESPACED.indexOf(key);
    if (mi < 0 && key !== "total") continue;
    if (key === "total") { total = { thisYear: values[String(y1)] ?? null, lastYear: values[String(y2)] ?? null }; continue; }
    const monthName = MONTHS[mi];
    if (values[String(y1)] != null) thisYear[monthName] = values[String(y1)];
    if (values[String(y2)] != null) lastYear[monthName] = values[String(y2)];
  }
  return { year: y1, priorYear: y2, thisYear, lastYear, total };
}

function parseHiring(rows, monthName) {
  // Despaced, like every other word match here: the older reports split words, and
  // "16,191" had been arriving as "16" ",191" and read as sixteen.
  const flat = despace(rows.map((r) => r.text).join(" "));
  const mon = monthName.toLowerCase();
  const m1 = flat.match(new RegExp(`announcedplanstohire([\\d,]+)(?:workers|positions|jobs|people|employees)in${mon}`))
    ?? flat.match(new RegExp(`planstohire([\\d,]+)[a-z,]{0,60}?in${mon}`));
  const m2 = flat.match(/sofarthisyear,?(?:companies|employers)haveannouncedplanstohire([\d,]+)/)
    ?? flat.match(/yeartodate,?(?:companies|employers)haveannouncedplanstohire([\d,]+)/)
    ?? flat.match(/through[a-z]+,?(?:companies|employers)haveannouncedplanstohire([\d,]+)/);
  return { month: m1 ? toInt(m1[1]) : null, ytd: m2 ? toInt(m2[1]) : null };
}

/** One PDF -> one month record, or {skip: reason}. */
function parseReport(rows, postUrl, pdfUrl) {
  const month = reportMonth(rows);
  if (!month) return { skip: "no report month in the title block (not a monthly report?)" };
  const monthName = MONTHS[Number(month.slice(5)) - 1];
  const reasons = parseReasons(rows, Number(month.slice(0, 4)));
  if (!reasons) return { skip: "Table 4 (job cuts by reason) not found or its header did not parse" };
  const totals = parseMonthlyTotals(rows);
  if (!totals) return { skip: "Table 1 month-by-month totals not found" };
  if (totals.year !== Number(month.slice(0, 4))) {
    return { skip: `Table 1 year ${totals.year} does not match the report month ${month}` };
  }
  const totalCuts = totals.thisYear[monthName] ?? null;
  if (totalCuts == null) return { skip: `Table 1 has no ${monthName} total` };
  // Year to date is the sum of this year's months through the report month, and it is
  // cross-checked against the table's own TOTAL row, which carries the same figure.
  let ytdCuts = 0;
  for (let i = 0; i <= MONTHS.indexOf(monthName); i++) {
    const v = totals.thisYear[MONTHS[i]];
    if (v == null) { ytdCuts = null; break; }
    ytdCuts += v;
  }
  const tableYtd = totals.total?.thisYear ?? null;
  if (ytdCuts != null && tableYtd != null && ytdCuts !== tableYtd) {
    return { skip: `year-to-date mismatch: months sum to ${ytdCuts}, TOTAL row says ${tableYtd}` };
  }
  // Matched despaced: kerning splits labels in the older reports.
  const find = (re) => Object.entries(reasons).find(([k]) => re.test(despace(k)))?.[1] ?? null;
  const ai = find(/^artificialintelligence(\(ai\))?$/);
  const possibly = find(/^technologicalupdate\(possiblyai\)$/);
  const automation = find(/^technologicalupdate\(automation\)$/);
  const tableTotal = find(/^total$/);
  // The reason table's own TOTAL row is a second cross-check on the month figure.
  if (tableTotal?.month != null && tableTotal.month !== totalCuts) {
    return { skip: `Table 4 TOTAL ${tableTotal.month} does not match Table 1 ${monthName} total ${totalCuts}` };
  }
  const pct = (a, b) => (a == null || b == null || b === 0 ? null : Math.round((a / b) * 1000) / 10);
  const hiring = parseHiring(rows, monthName);
  const reasonRows = Object.fromEntries(Object.entries(reasons).filter(([k]) => despace(k) !== "total"));
  return {
    month,
    releaseDate: releaseDate(rows),
    postUrl,
    pdfUrl,
    totalCuts,
    ytdCuts,
    aiCuts: ai?.month ?? null,
    aiYtd: ai?.ytd ?? null,
    aiSharePct: pct(ai?.month ?? null, totalCuts),
    aiYtdSharePct: pct(ai?.ytd ?? null, ytdCuts),
    aiTracked: ai != null,
    possiblyAiCuts: possibly?.month ?? null,
    possiblyAiYtd: possibly?.ytd ?? null,
    automationCuts: automation?.month ?? null,
    automationYtd: automation?.ytd ?? null,
    hiringPlans: hiring.month,
    hiringPlansYtd: hiring.ytd,
    // Every reason row, for the record. Labels are the publisher's.
    reasons: reasonRows,
  };
}

// --- Load the snapshot ---------------------------------------------------------
mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
let snapshot;
try {
  snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
} catch {
  snapshot = { schemaVersion: 1, months: [], skippedPosts: [] };
}
const known = new Set((snapshot.months ?? []).map((m) => m.postUrl));
const knownSkips = new Map((snapshot.skippedPosts ?? []).map((s) => [s.url, s.reason]));

// --- Walk the archive ----------------------------------------------------------
const posts = [];
for (let p = 1; p <= PAGES; p++) {
  const url = p === 1 ? CATEGORY_URL : `${CATEGORY_URL}page/${p}/`;
  let html;
  try {
    html = await fetchText(url, `challenger archive page ${p}`);
  } catch (e) {
    if (p === 1) fail(e.message ?? String(e));
    console.warn(`archive page ${p}: ${e.message ?? e}; stopping the walk here`);
    break;
  }
  const links = postLinks(html);
  if (links.length === 0) fail(`archive page ${p} lists no posts (site restructured?)`);
  posts.push(...links);
}

const added = [];
const skipped = [];
// Every skip is logged as it happens, so a run that parses nothing says WHY in the
// Actions log rather than only in the snapshot.
const skip = (url, reason) => { skipped.push({ url, reason }); console.warn(`skip ${url}\n     ${reason}`); };
for (const postUrl of posts) {
  if (known.has(postUrl)) continue;
  // The daily run does not re-try posts already known not to be monthly reports; a
  // backfill does, in case the parser improved.
  if (PAGES === 1 && knownSkips.has(postUrl)) continue;
  let html;
  try {
    html = await fetchText(postUrl, "challenger post");
  } catch (e) {
    skip(postUrl, `post fetch failed: ${e.message ?? e}`);
    continue;
  }
  const pdfUrl = pdfLink(html);
  if (!pdfUrl) { skip(postUrl, "no PDF linked from the post"); continue; }
  let rows;
  try {
    rows = await extractRows(await fetchBytes(pdfUrl, "challenger report PDF"));
  } catch (e) {
    skip(postUrl, `PDF fetch or parse failed: ${e.message ?? e}`);
    continue;
  }
  const rec = parseReport(rows, postUrl, pdfUrl);
  if (rec.skip) { skip(postUrl, rec.skip); continue; }
  added.push(rec);
  console.log(
    `parsed ${rec.month}: ${rec.totalCuts} cuts, AI ${rec.aiCuts ?? "n/a"} (${rec.aiSharePct ?? "n/a"}%), ` +
    `YTD ${rec.ytdCuts}, YTD AI ${rec.aiYtd ?? "n/a"}, hiring ${rec.hiringPlans ?? "n/a"}`,
  );
}

// --- Merge, keyed by month. A later release for the same month wins (a revision). ---
const byMonth = new Map((snapshot.months ?? []).map((m) => [m.month, m]));
for (const r of added) {
  const prior = byMonth.get(r.month);
  if (!prior || (r.releaseDate ?? "") >= (prior.releaseDate ?? "")) byMonth.set(r.month, r);
}
const months = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));

const newSkips = skipped.filter((s) => knownSkips.get(s.url) !== s.reason);
if (added.length === 0 && newSkips.length === 0) {
  console.log(`challenger: no new reports (${months.length} months on file, latest ${months.at(-1)?.month ?? "none"})`);
  process.exit(0);
}
if (months.length === 0) fail("no monthly report could be parsed at all");

const skipList = new Map(knownSkips);
for (const s of skipped) skipList.set(s.url, s.reason);
for (const m of months) skipList.delete(m.postUrl);

const next = {
  schemaVersion: 1,
  source: "Challenger, Gray & Christmas, monthly Job Cuts Report",
  sourceUrl: CATEGORY_URL,
  license: "Published freely by the firm; cite Challenger, Gray & Christmas.",
  note:
    "Announced US job cuts by the reason the employer stated, from the monthly report PDF. " +
    "Announcements, not realised separations; reasons are self-reported; Challenger keeps a separate " +
    "'Technological Update (possibly AI)' bucket for ambiguous cases, published here alongside. " +
    "AI has been tracked as a distinct reason since 2023, so there is no pre-2020 baseline and this " +
    "series carries no z-score. Each PDF carries one month plus year-to-date; the file accumulates. " +
    "Hiring plans come from the report narrative and are null where the wording did not match.",
  lastRefreshed: new Date().toISOString().slice(0, 10),
  months,
  skippedPosts: [...skipList].map(([url, reason]) => ({ url, reason })).slice(-80),
};
writeFileSync(SNAPSHOT_PATH, JSON.stringify(next, null, 2) + "\n", "utf8");
const latest = months[months.length - 1];
console.log(
  `challenger: ${months.length} months on file (+${added.length}), ${skipped.length} posts skipped; ` +
  `latest ${latest.month}: ${latest.totalCuts} cuts, AI ${latest.aiCuts ?? "n/a"}, YTD AI ${latest.aiYtd ?? "n/a"} (${latest.aiYtdSharePct ?? "n/a"}%)`,
);
