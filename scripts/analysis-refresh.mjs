// Designed with Claude (Anthropic)
//
// analyst-refresh (monthly): the Analyst — a mini-economist that reads the
// dashboard's own panels, commits to one of four fixed verdicts, and writes a
// short plain-language read around it.
//
// The verdict is DERIVED mechanically from the same panel state + thresholds that
// drive the on-device stoplight (analyst/verdict.mjs). The model never chooses it;
// it writes the tag line + analysis, and holds exactly one discretionary power —
// the downgrade-only analyst veto (news may only downgrade a directional verdict
// to CONFOUNDED, never produce or strengthen one).
//
// Cadence: monthly, after the BLS Employment Situation release, Action-triggered,
// cached. A reader opening the app costs nothing. MODEL: Sonnet 5.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { loadPool, saveSection, nowIso } from "./lib.mjs";
import { computeDashboardSummary } from "./metrics.mjs";
import { buildAnalysisPayload, votingPanelStates, votingDifferentialSeries } from "./payload.mjs";
import { deriveVerdict, DIRECTIONAL } from "./analyst/verdict.mjs";
import { DATA_INTEGRITY_MAX_STALE_MONTHS, VERDICT_CRITICAL_SERIES, HEAVY_REVISION_MAX_PP } from "./config.mjs";
import { assembleNews } from "./analyst/news.mjs";
import { SYSTEM_PROMPT, buildUserMessage } from "./analyst/prompt.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DISSENT_LOG_PATH = path.join(repoRoot, "data", "analyst", "dissent_log.json");
function readJson(rel) {
  try { return JSON.parse(readFileSync(path.join(repoRoot, rel), "utf8")); } catch { return null; }
}

const MODEL = "claude-sonnet-5";
const INPUT_USD_PER_TOKEN = 3 / 1_000_000;
const OUTPUT_USD_PER_TOKEN = 15 / 1_000_000;

// Cron day-of-month + day-of-week are OR'd, so "first Friday" must be enforced
// here (audit-2026-07 finding 3 / C-1): the workflow fires every Friday, and a
// scheduled run outside days 1-7 is not the month's first Friday. Guarded to
// scheduled runs so workflow_dispatch still works any day.
if (process.env.GITHUB_EVENT_NAME === "schedule" && new Date().getUTCDate() > 7) {
  console.log("analyst: not the first Friday of the month; exiting");
  process.exit(0);
}

const pool = loadPool();

function bumpTimestampOnly(reason) {
  console.log(`analyst: ${reason}; keeping prior verdict, updating timestamp only`);
  const a = pool.analysis ?? {};
  a.lastRefreshed = nowIso();
  saveSection("analysis", a);
}

if (!pool.fred.lastRefreshed || Object.keys(pool.fred.series ?? {}).length === 0) {
  bumpTimestampOnly("no FRED data in the pool yet");
  process.exit(0);
}

// --- Assemble the panel data (same snapshots the dashboard reads) ---
const extras = {
  metrRecords: readJson("data/metr/time_horizons.json")?.records ?? [],
  adoptionPoints: readJson("data/adoption/ai_adoption.json")?.points ?? [],
  aeiPoints: readJson("data/aei/augmentation.json")?.points ?? [],
  postingsPoints: readJson("data/postings/job_postings.json")?.points ?? [],
};
const summary = computeDashboardSummary(pool, extras);
const payload = buildAnalysisPayload(pool, {
  ...extras,
  inversion: summary.inversion,
  macro: summary.macro,
  metrTop5: summary.metrTop5,
  slots: summary.slots,
});
const votes = votingPanelStates(pool, extras);

// --- Derive the mechanical verdict (verdict.mjs port of the stoplight) ---
const jobsPanel = payload.find((p) => p.panel === "exposed_vs_control_jobs");
const latestLaborMonth = jobsPanel?.latest_date ?? null;

// Dissent log — read before the verdict derivation because heavy-revision
// detection diffs this run's differentials against the log's stored numbers.
const dissentLog = existsSync(DISSENT_LOG_PATH)
  ? JSON.parse(readFileSync(DISSENT_LOG_PATH, "utf8"))
  : { schemaVersion: 1, entries: [] };
const entries = dissentLog.entries ?? [];

/** Latest entry per data month (entries are sorted by date then runAt). */
function latestPerMonth(list) {
  const m = new Map();
  for (const e of list) m.set(e.date, e);
  return [...m.values()];
}

const diffSeries = votingDifferentialSeries(pool);

// Heavy-revision detection (audit-2026-07 finding 10 / D-1): re-read the last
// two logged data months' jobs/wages differentials from TODAY's pool and diff
// them against the numbers stored when those months were logged. A move
// beyond HEAVY_REVISION_MAX_PP means the BLS inputs were heavily revised —
// the "heavily revised" clause of CONFOUNDED pathway (b), now implemented.
function detectHeavyRevision() {
  const logged = latestPerMonth(entries).slice(-2);
  for (const e of logged) {
    if (!e.keyNumbers) continue; // entries logged before keyNumbers existed
    const stored = [["jobs", e.keyNumbers.jobsDiffPp], ["wages", e.keyNumbers.wagesDiffPp]];
    for (const [channel, was] of stored) {
      if (was == null) continue;
      const now = diffSeries[channel].find((p) => p.month === e.date)?.diff;
      if (now == null) continue;
      if (Math.abs(now - was) > HEAVY_REVISION_MAX_PP) {
        return `the ${e.date} exposed-vs-control ${channel} differential was revised from ${was.toFixed(2)} to ${now.toFixed(2)} percentage points — this month's BLS inputs are heavily revised`;
      }
    }
  }
  return null;
}

function computeDataIntegrity() {
  // Pathway (b): the month's BLS inputs are shifted/incomplete/heavily
  // revised. Conservative staleness check — if the labor series is missing or
  // >3 months stale, this month's Employment Situation is not yet reflected,
  // so the inputs are unstable.
  //
  // Verdict-critical presence (audit-2026-07 finding 2 / C-2): a series the
  // verdict depends on that is absent from the pool — a vanished macro spread
  // silently disarming the recession veto, a vanished CES series silently
  // shrinking the voting set — must read as "no data", never as benign.
  const missing = VERDICT_CRITICAL_SERIES.filter((id) => !(pool.fred.series?.[id]?.length > 0));
  if (missing.length > 0) {
    return { ok: false, reason: `verdict-critical series missing from the data pool: ${missing.join(", ")} — absence must not read as a benign value` };
  }
  if (!latestLaborMonth) {
    return { ok: false, reason: "the exposed-vs-control labor series is missing from the data pool this month" };
  }
  const [y, m] = latestLaborMonth.split("-").map(Number);
  const now = new Date();
  const monthsStale = (now.getUTCFullYear() * 12 + now.getUTCMonth()) - (y * 12 + (m - 1));
  if (monthsStale > DATA_INTEGRITY_MAX_STALE_MONTHS) {
    return { ok: false, reason: `the latest labor data is ${latestLaborMonth}, more than three months stale — this month's Employment Situation is not yet reflected` };
  }
  const revision = detectHeavyRevision();
  if (revision) {
    return { ok: false, reason: revision };
  }
  return { ok: true, reason: null };
}

const prodSeries = [...(pool.fred.series?.PRS85006091 ?? [])].sort((a, b) => a.date.localeCompare(b.date));
const productivityYoY = prodSeries.length ? prodSeries[prodSeries.length - 1].value : null;
const aei = summary.aeiUse
  ? { augmentPct: summary.aeiUse.latestAugmentPct, automatePct: summary.aeiUse.latestAutomatePct }
  : null;

const derived = deriveVerdict({
  laborVoteStates: [votes.jobs, votes.wages, votes.postings],
  recessionVeto: summary.macro?.recessionSignal === true,
  capabilityOpen: (summary.metrTop5 ?? []).length > 0,
  adoptionRising: summary.adoption?.rising === true,
  productivityYoY,
  aei,
  dataIntegrity: computeDataIntegrity(),
});

// --- News package ---
const nowMs = Date.now();
const news = await assembleNews(pool, nowMs);
const dataMonth = news.dataMonth ?? latestLaborMonth ?? nowIso().slice(0, 7);

// Idempotency: re-running the same month with unchanged inputs is a no-op;
// changed inputs (e.g. a revision) APPEND a new entry that supersedes the
// month's prior one (audit-2026-07 finding 15 / C-4) — the log itself records
// that the month's call changed; nothing is deleted.
const round = (v) => (typeof v === "number" ? Math.round(v * 100) / 100 : v);
const fingerprint = createHash("sha256")
  .update(JSON.stringify({ verdict: derived.verdict, payload, dataMonth }, (k, v) => round(v)))
  .digest("hex");
const monthEntries = entries.filter((e) => e.date === dataMonth);
const priorForMonth = monthEntries[monthEntries.length - 1] ?? null;
if (priorForMonth && priorForMonth.inputsFingerprint === fingerprint && pool.analysis?.text) {
  bumpTimestampOnly(`already logged the ${dataMonth} verdict with unchanged inputs`);
  process.exit(0);
}

// --- Request ---
const requestBody = {
  model: MODEL,
  max_tokens: 1500,
  system: SYSTEM_PROMPT,
  messages: [{ role: "user", content: buildUserMessage(derived, payload, latestPerMonth(entries), news.text) }],
};

// Dry run: print the derivation + news status + request body, make NO model call
// and write NOTHING to the pool or the log. Lets the whole pipeline be validated
// (verdict derivation, news fetch, prompt assembly, privacy) for zero spend.
if (process.argv.includes("--dry-run")) {
  writeFileSync(
    "analyst-request-dryrun.json",
    JSON.stringify({ derived, dataMonth, newsSources: news.sources, requestBody }, null, 2) + "\n",
  );
  console.log("=== DRY RUN (no model call, nothing written) ===");
  console.log(`derived verdict : ${derived.verdict}`);
  console.log(`mechanical state: ${derived.mechanicalState} | breadth ${derived.breadth} | gainsVisible ${derived.gainsVisible}`);
  console.log(`confounded path : ${derived.confoundedPathway ?? "(none)"}`);
  console.log(`labor votes     : jobs=${votes.jobs} wages=${votes.wages} postings=${votes.postings}`);
  console.log(`data month      : ${dataMonth}`);
  console.log(`news sources    : ${news.sources.map((s) => `${s.id}:${s.status}`).join(", ")}`);
  console.log(`request keys    : ${Object.keys(requestBody).join(", ")}`);
  console.log(`metadata present: ${Object.prototype.hasOwnProperty.call(requestBody, "metadata")}`);
  process.exit(0);
}

// --- Model call ---
const client = new Anthropic(); // reads ANTHROPIC_API_KEY
let message;
try {
  message = await client.messages.stream(requestBody).finalMessage();
} catch (err) {
  console.error("analyst call failed; prior analysis left untouched:", err.message ?? err);
  process.exit(1);
}

const raw = message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();

/** Line-delimited parse (robust to multi-paragraph prose that would break JSON). */
function parseModel(text) {
  const tag = text.match(/^\s*TAGLINE:\s*(.+?)\s*$/im);
  const veto = text.match(/^\s*VETO:\s*(yes|no)\b/im);
  const conf = text.match(/^\s*CONFOUNDER:\s*(.+?)\s*$/im);
  const aIdx = text.search(/^\s*ANALYSIS:\s*$/im);
  let analysis = null;
  if (aIdx >= 0) {
    analysis = text.slice(aIdx).replace(/^\s*ANALYSIS:\s*\n?/i, "").trim();
  }
  if (!tag || !analysis) return null;
  const vetoYes = !!veto && /yes/i.test(veto[1]);
  const confounder = conf && !/^none$/i.test(conf[1].trim()) ? conf[1].trim() : null;
  return { tagLine: tag[1].trim(), analysis, vetoInvoke: vetoYes, vetoConfounder: confounder };
}
const parsed = parseModel(raw);
if (!parsed) {
  console.error("analyst: could not parse TAGLINE/ANALYSIS from the model; prior analysis left untouched.");
  console.error("--- model output (first 600 chars) ---");
  console.error(raw.slice(0, 600));
  process.exit(1);
}

// --- Apply the downgrade-only analyst veto (the ONLY way news moves the verdict) ---
let verdict = derived.verdict;
let confoundedPathway = derived.confoundedPathway;
let namedConfounder = derived.namedConfounder;
if (DIRECTIONAL.has(derived.verdict) && parsed.vetoInvoke && parsed.vetoConfounder) {
  verdict = "CONFOUNDED";
  confoundedPathway = "analyst_veto";
  namedConfounder = parsed.vetoConfounder;
}
// A directional->other-directional or CONFOUNDED->directional change is structurally
// impossible here: the veto is the sole override and it only downgrades.

const runAt = nowIso();
const analysisText = String(parsed.analysis).trim();
const tagLine = String(parsed.tagLine).trim();
const isConfounded = verdict === "CONFOUNDED";

// --- Persist: pool.analysis (keeps `text` for the current app) ---
saveSection("analysis", {
  lastRefreshed: runAt,
  dataMonth,
  verdict,
  tagLine,
  confoundedPathway: isConfounded ? confoundedPathway : null,
  namedConfounder: isConfounded ? namedConfounder : null,
  mechanicalState: derived.mechanicalState,
  breadth: derived.breadth,
  text: analysisText,
  inputsFingerprint: fingerprint,
});

// --- Append the dissent-log entry (append-only; a same-month revision
// --- supersedes, never deletes — finding 15) ---
const entry = {
  date: dataMonth,
  runAt,
  verdict,
  tagLine,
  confoundedPathway: isConfounded ? confoundedPathway : null,
  namedConfounder: isConfounded ? namedConfounder : null,
  mechanicalState: derived.mechanicalState,
  breadth: derived.breadth,
  analysis: analysisText,
  inputsFingerprint: fingerprint,
  // The differentials as read this run, for heavy-revision detection
  // (finding 10): a later run re-reads these months and diffs.
  keyNumbers: {
    jobsDiffPp: diffSeries.jobs.find((p) => p.month === dataMonth)?.diff ?? null,
    wagesDiffPp: diffSeries.wages.find((p) => p.month === dataMonth)?.diff ?? null,
  },
  ...(priorForMonth ? { supersedes: priorForMonth.runAt } : {}),
};
const newEntries = [...entries, entry];
newEntries.sort((a, b) => a.date.localeCompare(b.date) || String(a.runAt ?? "").localeCompare(String(b.runAt ?? "")));
writeFileSync(
  DISSENT_LOG_PATH,
  JSON.stringify({ schemaVersion: dissentLog.schemaVersion ?? 1, description: dissentLog.description, lastRefreshed: runAt, entries: newEntries }, null, 2) + "\n",
  "utf8",
);

// Usage — maintainer log only, NEVER published to the pool.
const inTok = message.usage?.input_tokens ?? 0;
const outTok = message.usage?.output_tokens ?? 0;
const costUsd = inTok * INPUT_USD_PER_TOKEN + outTok * OUTPUT_USD_PER_TOKEN;
const words = analysisText.split(/\s+/).filter(Boolean).length;
if (words > 350) console.warn(`WARN analysis is ${words} words (>350)`);
console.log(
  `analyst: ${verdict} — "${tagLine}" (${dataMonth})` +
  (isConfounded ? ` [${confoundedPathway}: ${namedConfounder}]` : "") +
  ` — usage (log only): ${inTok} in / ${outTok} out, est $${costUsd.toFixed(4)}`,
);
