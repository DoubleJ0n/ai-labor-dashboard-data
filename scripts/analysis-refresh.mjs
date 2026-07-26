// Designed with Claude (Anthropic)
//
// The Analyst — a two-pass read of the dashboard's own panels.
//
// PASS 1 is blind: current data, long-run history, what moved since last run, and
// the news package. No prior verdict. It picks AUGMENTATION or DISPLACEMENT (or
// CONFOUNDED with a named cause), inverts every panel it leans on, and pre-registers
// a falsifier on a fixed 90-day horizon. Its reasoning log is uncapped and stored,
// never shown. PASS 2 writes the 400-500 word published note and the notification
// line. Pass 2 cannot alter the verdict; disagreement is logged instead.
//
// The mechanical stoplight is computed alongside and LOGGED, never sent to the
// model: the rule-based lights have to be able to visibly disagree with the
// analyst, and they cannot if the analyst was shown the answer first.
//
// Cadence: weekly, skipped when no input moved. Every run APPENDS — to
// data/analyst/dissent_log.json (the app's timeline) and to data/analyst/runs.json
// (the full audit record). Nothing is ever overwritten.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { loadPool, saveSection, nowIso } from "./lib.mjs";
import { computeDashboardSummary } from "./metrics.mjs";
import {
  buildAnalysisPayload, votingPanelStates, votingDifferentialSeries,
  panelHeadlines, changesSinceLastRun,
} from "./payload.mjs";
import { deriveVerdict } from "./analyst/verdict.mjs";
import { DATA_INTEGRITY_MAX_STALE_MONTHS, VERDICT_CRITICAL_SERIES, HEAVY_REVISION_MAX_PP } from "./config.mjs";
import { assembleNews } from "./analyst/news.mjs";
import {
  PASS1_SYSTEM, PASS2_SYSTEM, buildPass1Message, buildPass2Message,
  parsePass1, parsePass2, noteCompliance, FALSIFIER_HORIZON_DAYS,
} from "./analyst/prompt.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DISSENT_LOG_PATH = path.join(repoRoot, "data", "analyst", "dissent_log.json");
const RUNS_PATH = path.join(repoRoot, "data", "analyst", "runs.json");
function readJson(rel) {
  try { return JSON.parse(readFileSync(path.join(repoRoot, rel), "utf8")); } catch { return null; }
}

// --- Models, effort, and money ------------------------------------------------
//
// Both models take adaptive thinking (`budget_tokens` is rejected with a 400) and
// effort inside output_config. Effort already defaults to high on the Claude API;
// it is set explicitly anyway so the run record can state what it ran at.
//
// Pinned exactly, not by a family alias. Model IDs from the 4.6 generation on are
// dateless but are still pinned snapshots rather than evergreen pointers, so this
// string cannot silently repoint mid-series and break the track record.
const DEFAULT_MODEL = "claude-opus-5";
const EFFORT = "high";
// max_tokens is a HARD cap on thinking + visible text together. The previous
// 1500 was set when this call didn't think; at high effort it would truncate
// mid-sentence, so it is generous now and the request streams. Pass 1's reasoning
// log is uncapped by design, which makes the headroom load-bearing.
const MAX_TOKENS = 16000;

// Per-million-token pricing. Sonnet 5's introductory rate ends 2026-08-31; both
// sides are recorded so a cost computed after the cutover is still right.
const PRICING = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": {
    input: 3, output: 15,
    intro: { input: 2, output: 10, through: "2026-08-31" },
  },
};

function rateFor(model, onIso) {
  const p = PRICING[model];
  if (!p) return null;
  const day = String(onIso).slice(0, 10);
  if (p.intro && day <= p.intro.through) return { input: p.intro.input, output: p.intro.output, intro: true };
  return { input: p.input, output: p.output, intro: false };
}

function costUsd(model, inTok, outTok, onIso) {
  const r = rateFor(model, onIso);
  if (!r) return null;
  // Thinking tokens bill as output, so outTok is larger than the visible text.
  return (inTok * r.input + outTok * r.output) / 1_000_000;
}

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const AB_RUN = args.includes("--ab");
// One question, asked once: is this a side mode that must not write or spend?
// Every write-guard and every early-exit reads THIS rather than enumerating the
// modes it knows about. Enumerating is how --dry-run ended up writing to the pool:
// the weekly gate excluded --ab but predated --dry-run, so a dry run fell into a
// branch that calls saveSection. A new mode joins by being added here, once.
const SIDE_MODE = DRY_RUN || AB_RUN;

const pool = loadPool();

function bumpTimestampOnly(reason) {
  if (SIDE_MODE) {
    console.log(`analyst: ${reason}; side mode, so writing nothing`);
    return;
  }
  console.log(`analyst: ${reason}; keeping prior verdict, updating timestamp only`);
  const a = pool.analysis ?? {};
  a.lastRefreshed = nowIso();
  saveSection("analysis", a);
}

if (!pool.fred.lastRefreshed || Object.keys(pool.fred.series ?? {}).length === 0) {
  bumpTimestampOnly("no FRED data in the pool yet");
  process.exit(0);
}

// --- Assemble the panel data (the same snapshots the dashboard reads) ---------
const extras = {
  metrRecords: readJson("data/metr/time_horizons.json")?.records ?? [],
  adoptionPoints: readJson("data/adoption/ai_adoption.json")?.points ?? [],
  aeiPoints: readJson("data/aei/augmentation.json")?.points ?? [],
  postingsPoints: readJson("data/postings/job_postings.json")?.points ?? [],
  gdpval: readJson("data/gdpval/leaderboard.json") ?? null,
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

const jobsPanel = payload.find((p) => p.panel === "exposed_vs_control_jobs");
const latestLaborMonth = jobsPanel?.latest_date ?? null;

// --- History: dissent log (timeline) + runs log (audit) -----------------------
const dissentLog = existsSync(DISSENT_LOG_PATH)
  ? JSON.parse(readFileSync(DISSENT_LOG_PATH, "utf8"))
  : { schemaVersion: 1, entries: [] };
const entries = dissentLog.entries ?? [];
const runsLog = existsSync(RUNS_PATH)
  ? JSON.parse(readFileSync(RUNS_PATH, "utf8"))
  : { schemaVersion: 1, description: "Append-only Analyst run history. Every run, nothing overwritten.", runs: [] };
const runs = runsLog.runs ?? [];

/** The most recent logged run, whatever data month it belongs to. */
const priorEntry = entries.length ? entries[entries.length - 1] : null;
const priorRun = runs.length ? runs[runs.length - 1] : null;

const diffSeries = votingDifferentialSeries(pool);

// Heavy-revision detection (audit-2026-07 finding 10): re-read the last two
// logged data months' differentials from TODAY's pool and diff them against the
// numbers stored when those months were logged. A move beyond the registered
// threshold means the BLS inputs were revised out from under a published call.
function detectHeavyRevision() {
  const byMonth = new Map();
  for (const e of entries) byMonth.set(e.date, e);
  for (const e of [...byMonth.values()].slice(-2)) {
    const stored = e.keyNumbers;
    if (!stored) continue;
    for (const [channel, was] of [["jobs", stored.jobsDiffPp], ["wages", stored.wagesDiffPp]]) {
      if (was == null) continue;
      const now = diffSeries[channel].find((p) => p.month === e.date)?.diff;
      if (now == null) continue;
      if (Math.abs(now - was) > HEAVY_REVISION_MAX_PP) {
        return `the ${e.date} exposed-vs-control ${channel} differential was revised from ${was.toFixed(2)} to ${now.toFixed(2)} percentage points since it was published`;
      }
    }
  }
  return null;
}

function computeDataIntegrity() {
  const missing = VERDICT_CRITICAL_SERIES.filter((id) => !(pool.fred.series?.[id]?.length > 0));
  if (missing.length > 0) {
    return { ok: false, reason: `verdict-critical series missing from the data pool: ${missing.join(", ")} — absence must not read as a benign value` };
  }
  if (!latestLaborMonth) {
    return { ok: false, reason: "the exposed-vs-control labor series is missing from the data pool" };
  }
  const [y, m] = latestLaborMonth.split("-").map(Number);
  const now = new Date();
  const monthsStale = (now.getUTCFullYear() * 12 + now.getUTCMonth()) - (y * 12 + (m - 1));
  if (monthsStale > DATA_INTEGRITY_MAX_STALE_MONTHS) {
    return { ok: false, reason: `the latest labor data is ${latestLaborMonth}, more than ${DATA_INTEGRITY_MAX_STALE_MONTHS} months stale` };
  }
  const revision = detectHeavyRevision();
  if (revision) return { ok: false, reason: revision };
  return { ok: true, reason: null };
}

const prodSeries = [...(pool.fred.series?.PRS85006091 ?? [])].sort((a, b) => a.date.localeCompare(b.date));
const productivityYoY = prodSeries.length ? prodSeries[prodSeries.length - 1].value : null;
const aei = summary.aeiUse
  ? { augmentPct: summary.aeiUse.latestAugmentPct, automatePct: summary.aeiUse.latestAutomatePct }
  : null;
const dataIntegrity = computeDataIntegrity();

// The MECHANICAL reading, computed for the record only. It is logged so the app
// can show it beside the analyst's call — and so the two can visibly disagree.
// It is never placed in either prompt.
const mechanical = deriveVerdict({
  laborVoteStates: [votes.jobs, votes.wages, votes.postings],
  recessionVeto: summary.macro?.recessionSignal === true,
  capabilityOpen: true, // capability gate retired 2026-07; it conditions nothing
  adoptionRising: summary.adoption?.rising === true,
  productivityYoY,
  aei,
  dataIntegrity,
});

// --- News + what-changed ------------------------------------------------------
const news = await assembleNews(pool, Date.now());
const dataMonth = news.dataMonth ?? latestLaborMonth ?? nowIso().slice(0, 7);
const headlines = panelHeadlines(payload);
const changes = changesSinceLastRun(
  payload,
  priorRun?.panelHeadlines ?? priorEntry?.panelHeadlines ?? null,
  priorRun?.runAt ?? priorEntry?.runAt ?? null,
  priorEntry?.date ?? null,
);

// The input snapshot hash. Without it you cannot audit why a past verdict looked
// reasonable at the time, so it is recorded on every run and gates the weekly
// re-run: unchanged inputs mean there is nothing new to say.
const round = (v) => (typeof v === "number" ? Math.round(v * 100) / 100 : v);
const inputHash = createHash("sha256")
  .update(JSON.stringify({ payload, dataMonth }, (k, v) => round(v)))
  .digest("hex");

// --- Deterministic CONFOUNDED: decline to ask rather than override the model --
// If this month's inputs are unstable, the honest output is "confounded, because
// the data is broken", and paying for a model call to say so would be silly. The
// code never overrides a verdict the model gave; it just doesn't ask for one.
if (dataIntegrity.ok === false && !SIDE_MODE) {
  const runAt = nowIso();
  const text =
    `The inputs this run are not stable enough to read: ${dataIntegrity.reason}. ` +
    `No directional call is being made on data this shaky; the previous reading stands until the next clean release.`;
  appendEntry({
    date: dataMonth, runAt, verdict: "CONFOUNDED",
    tagLine: "inputs unstable this run", notificationLine: "New results are in: confounded verdict, this run's data is unstable",
    confoundedPathway: "data_integrity", namedConfounder: dataIntegrity.reason,
    falsifier: null,
    falsifierPlain: "a clean data release that restores the missing series and leaves prior months unrevised",
    dissent: null, analysis: text, compliance: null,
  }, null); // no model ran, so there are no passes and no usage to record
  console.log(`analyst: data integrity failed (${dataIntegrity.reason}); logged CONFOUNDED without a model call`);
  process.exit(0);
}

// --- Weekly gate: skip the paid call when nothing moved ----------------------
if (!SIDE_MODE && priorRun && priorRun.inputHash === inputHash && pool.analysis?.text) {
  bumpTimestampOnly(`inputs unchanged since the last run (${priorRun.runAt})`);
  process.exit(0);
}

// --- Request builders --------------------------------------------------------
function pass1Request(model) {
  return {
    model,
    max_tokens: MAX_TOKENS,
    thinking: { type: "adaptive" },
    output_config: { effort: EFFORT },
    system: PASS1_SYSTEM,
    messages: [{ role: "user", content: buildPass1Message(payload, changes, news.text) }],
  };
}
function pass2Request(model, pass1) {
  return {
    model,
    max_tokens: MAX_TOKENS,
    thinking: { type: "adaptive" },
    output_config: { effort: EFFORT },
    system: PASS2_SYSTEM,
    messages: [{ role: "user", content: buildPass2Message(pass1, priorEntry, changes) }],
  };
}

if (DRY_RUN) {
  const body = pass1Request(DEFAULT_MODEL);
  writeFileSync(
    "analyst-request-dryrun.json",
    JSON.stringify({ mechanical, dataMonth, inputHash, newsSources: news.sources, pass1Request: body }, null, 2) + "\n",
  );
  console.log("=== DRY RUN (no model call, nothing written) ===");
  console.log(`mechanical state : ${mechanical.mechanicalState} | breadth ${mechanical.breadth} | gainsVisible ${mechanical.gainsVisible}`);
  console.log(`labor votes      : jobs=${votes.jobs} wages=${votes.wages} postings=${votes.postings}`);
  console.log(`data integrity   : ${dataIntegrity.ok ? "ok" : `FAILED — ${dataIntegrity.reason}`}`);
  console.log(`data month       : ${dataMonth}`);
  console.log(`input hash       : ${inputHash.slice(0, 16)}…`);
  console.log(`panels in payload: ${payload.length}`);
  console.log(`panels that moved: ${changes.panels_that_moved?.length ?? "(first run)"}`);
  console.log(`news sources     : ${news.sources.map((s) => `${s.id}:${s.status}`).join(", ")}`);
  console.log(`request keys     : ${Object.keys(body).join(", ")}`);
  console.log(`metadata present : ${Object.prototype.hasOwnProperty.call(body, "metadata")}`);
  console.log(`effort / thinking: ${body.output_config.effort} / ${body.thinking.type}`);
  process.exit(0);
}

// --- Model calls -------------------------------------------------------------
const client = new Anthropic(); // reads ANTHROPIC_API_KEY

async function callModel(request, label) {
  // Streaming: max_tokens this large risks an HTTP timeout on a plain create().
  const message = await client.messages.stream(request).finalMessage();
  const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  return {
    text,
    usage: {
      inputTokens: message.usage?.input_tokens ?? 0,
      // Thinking bills as output, so this exceeds the visible text.
      outputTokens: message.usage?.output_tokens ?? 0,
    },
    label,
  };
}

/** One full two-pass run on one model. Returns everything needed to log or compare. */
async function runAnalyst(model) {
  const startedAt = nowIso();
  const first = await callModel(pass1Request(model), "pass1");
  const pass1 = parsePass1(first.text);
  if (!pass1) {
    throw new Error(`pass 1 output did not parse (model ${model}). First 600 chars:\n${first.text.slice(0, 600)}`);
  }
  const second = await callModel(pass2Request(model, pass1), "pass2");
  const pass2 = parsePass2(second.text);
  if (!pass2) {
    throw new Error(`pass 2 output did not parse (model ${model}). First 600 chars:\n${second.text.slice(0, 600)}`);
  }
  const finishedAt = nowIso();
  const inTok = first.usage.inputTokens + second.usage.inputTokens;
  const outTok = first.usage.outputTokens + second.usage.outputTokens;
  return {
    model, effort: EFFORT, startedAt, finishedAt,
    pass1, pass2,
    rawPass1: first.text, rawPass2: second.text,
    usage: {
      pass1: first.usage, pass2: second.usage,
      totalInputTokens: inTok, totalOutputTokens: outTok,
      costUsd: costUsd(model, inTok, outTok, finishedAt),
      rate: rateFor(model, finishedAt),
    },
    text: pass2.publishedNote,
    compliance: noteCompliance(pass2.publishedNote),
  };
}

// --- A/B mode: two models, one snapshot, report only -------------------------
if (AB_RUN) {
  const models = ["claude-sonnet-5", "claude-opus-5"];
  const results = [];
  for (const model of models) {
    console.log(`\n=== ${model} (effort ${EFFORT}, two passes) ===`);
    try {
      const r = await runAnalyst(model);
      results.push(r);
      console.log(`verdict     : ${r.pass1.verdict}`);
      console.log(`tag line    : ${r.pass2.tagLine}`);
      console.log(`notification: ${r.pass2.notificationLine} (${r.pass2.notificationLine.length} chars)`);
      console.log(`pass 2 dissent: ${r.pass2.dissented ? r.pass2.dissentNote : "no"}`);
      console.log(`note        : ${r.compliance.words} words, ${r.compliance.numbers} numbers` +
        `${r.compliance.withinWordRange ? "" : " [OUTSIDE 400-500]"}${r.compliance.withinNumberCeiling ? "" : " [OVER 10 NUMBERS]"}`);
      console.log(`tokens      : ${r.usage.totalInputTokens} in / ${r.usage.totalOutputTokens} out` +
        ` (pass1 ${r.usage.pass1.inputTokens}/${r.usage.pass1.outputTokens}, pass2 ${r.usage.pass2.inputTokens}/${r.usage.pass2.outputTokens})`);
      console.log(`cost        : $${r.usage.costUsd.toFixed(4)} at $${r.usage.rate.input}/$${r.usage.rate.output} per MTok${r.usage.rate.intro ? " (introductory)" : ""}`);
      console.log(`\n--- full response text ---\n${r.text}\n`);
    } catch (err) {
      console.error(`${model} FAILED: ${err.message ?? err}`);
      results.push({ model, error: String(err.message ?? err) });
    }
  }
  writeFileSync(
    path.join(repoRoot, "analyst-ab-report.json"),
    JSON.stringify({ runAt: nowIso(), dataMonth, inputHash, effort: EFFORT, mechanical, results }, null, 2) + "\n",
  );
  console.log("\nWrote analyst-ab-report.json. Nothing published — the pool and both logs are untouched.");
  process.exit(0);
}

// --- Normal run --------------------------------------------------------------
let result;
try {
  result = await runAnalyst(DEFAULT_MODEL);
} catch (err) {
  console.error("analyst call failed; prior analysis left untouched:", err.message ?? err);
  process.exit(1);
}

appendEntry(
  {
    date: dataMonth,
    runAt: result.finishedAt,
    verdict: result.pass1.verdict,
    tagLine: result.pass2.tagLine,
    notificationLine: result.pass2.notificationLine,
    confoundedPathway: result.pass1.verdict === "CONFOUNDED" ? "analyst" : null,
    namedConfounder: result.pass1.confounder,
    falsifier: result.pass1.falsifier,
    falsifierPlain: result.pass1.falsifierPlain,
    dissent: result.pass2.dissented ? result.pass2.dissentNote : null,
    analysis: result.text,
    compliance: result.compliance,
  },
  result,
);

console.log(
  `analyst: ${result.pass1.verdict} "${result.pass2.tagLine}" (${dataMonth}); ` +
  `mechanical ${mechanical.mechanicalState}` +
  (result.pass2.dissented ? "; PASS 2 DISSENTED" : "") +
  `; note ${result.compliance.words}w/${result.compliance.numbers}n` +
  ` — usage (log only): ${result.usage.totalInputTokens} in / ${result.usage.totalOutputTokens} out, ` +
  `est $${result.usage.costUsd.toFixed(4)}`,
);

/**
 * Append to BOTH logs. The dissent log is the app's timeline (public, small); the
 * runs log is the audit record (both passes verbatim, usage, cost, input hash).
 * Append-only in both: a revised month adds an entry, it never edits one.
 */
function appendEntry(entry, result) {
  const withNumbers = {
    ...entry,
    mechanicalState: mechanical.mechanicalState,
    breadth: mechanical.breadth,
    inputsFingerprint: inputHash,
    // For heavy-revision detection on a later run.
    keyNumbers: {
      jobsDiffPp: diffSeries.jobs.find((p) => p.month === dataMonth)?.diff ?? null,
      wagesDiffPp: diffSeries.wages.find((p) => p.month === dataMonth)?.diff ?? null,
    },
    panelHeadlines: headlines,
  };
  writeFileSync(
    DISSENT_LOG_PATH,
    JSON.stringify(
      {
        schemaVersion: dissentLog.schemaVersion ?? 1,
        description: dissentLog.description,
        lastRefreshed: entry.runAt,
        entries: [...entries, withNumbers],
      },
      null, 2,
    ) + "\n",
    "utf8",
  );

  writeFileSync(
    RUNS_PATH,
    JSON.stringify(
      {
        schemaVersion: runsLog.schemaVersion ?? 1,
        description: runsLog.description,
        lastRefreshed: entry.runAt,
        runs: [
          ...runs,
          {
            runAt: entry.runAt,
            dataMonth,
            model: result?.model ?? null,
            effort: result?.effort ?? null,
            verdict: entry.verdict,
            falsifier: entry.falsifier,
            falsifierPlain: entry.falsifierPlain,
            falsifierHorizonDays: FALSIFIER_HORIZON_DAYS,
            publishedNoteCompliance: entry.compliance,
            namedConfounder: entry.namedConfounder,
            mechanicalState: mechanical.mechanicalState,
            breadth: mechanical.breadth,
            gainsVisible: mechanical.gainsVisible,
            inputHash,
            // Oscillation is MEASURED, not suppressed. A two-consecutive-periods
            // confirmation rule would delay a real turn as readily as it damps a
            // wobble, so the flip is recorded and left visible instead; if the
            // record shows the call flapping week to week, that is the evidence
            // for adding the rule rather than a guess.
            flippedFromPriorRun: priorRun ? priorRun.verdict !== entry.verdict : null,
            priorRunVerdict: priorRun?.verdict ?? null,
            panelHeadlines: headlines,
            newsSources: news.sources,
            passes: result
              ? {
                  // The reasoning log lives HERE and only here: stored for audit,
                  // never published to the pool and never shown in the app.
                  pass1: { verdict: result.pass1.verdict, falsifier: result.pass1.falsifier, falsifierPlain: result.pass1.falsifierPlain, reasoningLog: result.pass1.reasoningLog, raw: result.rawPass1 },
                  pass2: { tagLine: result.pass2.tagLine, notificationLine: result.pass2.notificationLine, dissented: result.pass2.dissented, dissentNote: result.pass2.dissentNote, publishedNote: result.pass2.publishedNote, raw: result.rawPass2 },
                }
              : null,
            usage: result?.usage ?? null,
          },
        ],
      },
      null, 2,
    ) + "\n",
    "utf8",
  );

  // The pool section the app reads. `text` stays the field the current UI renders.
  saveSection("analysis", {
    lastRefreshed: entry.runAt,
    dataMonth,
    verdict: entry.verdict,

    tagLine: entry.tagLine,
    notificationLine: entry.notificationLine,
    falsifier: entry.falsifierPlain,
    confoundedPathway: entry.confoundedPathway,
    namedConfounder: entry.namedConfounder,
    mechanicalState: mechanical.mechanicalState,
    breadth: mechanical.breadth,
    text: entry.analysis,
    inputsFingerprint: inputHash,
  });

  // Notification fires on NEW ANALYSIS only, never on a data refresh — this is
  // the one place that signal is emitted, and it only runs after an append.
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `notify=true\nnotification_line<<EOF\n${entry.notificationLine}\nEOF\n`,
    );
  }
}
