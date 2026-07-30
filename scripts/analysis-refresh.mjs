// Designed with Claude (Anthropic)
//
// The Analyst — a two-pass read of the dashboard's own panels.
//
// PASS 1 is blind: current data, long-run history, what moved since last run, and
// the news package. No prior verdict. It picks AUGMENTATION or DISPLACEMENT (or
// CONFOUNDED with a named cause), inverts every panel it leans on, and pre-registers
// a falsifier on a fixed 90-day horizon. Its reasoning log is uncapped and stored,
// never shown. PASS 2 writes the published note, the full analysis and the
// notification line, at a length proportional to what changed. Pass 2 cannot alter
// the verdict, and as of 2026-07-28 it is no longer asked whether it agrees with
// one: divergence is COMPUTED here, after both readings exist, against mechanical
// values neither pass ever saw. See computeDissent.
//
// The mechanical stoplight is computed alongside and LOGGED, never sent to the
// model: the rule-based lights have to be able to visibly disagree with the
// analyst, and they cannot if the analyst was shown the answer first.
//
// Cadence: weekly, skipped when no input moved. Every run APPENDS — to
// data/analyst/dissent_log.json (the app's timeline) and to data/analyst/runs.json
// (the full audit record). Nothing is ever overwritten.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
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
import { pairedStateFromPool } from "./analyst/pairedState.mjs";
import { resolveOutstanding } from "./analyst/falsifier.mjs";
import { DATA_INTEGRITY_MAX_STALE_MONTHS, VERDICT_CRITICAL_SERIES, HEAVY_REVISION_MAX_PP } from "./config.mjs";
import { assembleNews } from "./analyst/news.mjs";
import {
  PASS1_SYSTEM, PASS2_SYSTEM, buildPass1Message, buildPass2Message,
  parsePass1, parsePass2, noteCompliance, analysisCompliance, FALSIFIER_HORIZON_DAYS,
  FIRST_RUN_ADDENDUM,
} from "./analyst/prompt.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DISSENT_LOG_PATH = path.join(repoRoot, "data", "analyst", "dissent_log.json");
const RUNS_PATH = path.join(repoRoot, "data", "analyst", "runs.json");
// Per-run transcripts. The most useful diagnostic in review is the DIFFERENCE between
// what a run concluded and what it published, and that is only visible with both in
// hand, so both are kept as files per run rather than only inside runs.json where a
// 3000-word log is unreadable.
const TRANSCRIPT_DIR = path.join(repoRoot, "data", "analyst", "runs");
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
  adoptionBySize: readJson("data/adoption/ai_adoption.json")?.bySize ?? null,
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

// The paired state: computed every run, stored beside it, NEVER sent to the model.
// The analyst gets the panels for both axes (attribution and reabsorption) and
// reasons to its own conclusion; this is the mechanical check that conclusion is
// measured against afterwards, the same way the existing stoplight is. Handing the
// model its own answer would turn the analyst into a formatter for a rule engine.
// payload.test.mjs asserts this value never reaches the request body.
const paired = pairedStateFromPool(pool);

// Score every prior run's falsifier against TODAY's panels, before the model is
// called. Until now these were pre-registered and never checked, which produced
// the appearance of a track record and none of the substance. The resolved record
// goes to pass 2 so the analyst sees its own history rather than being told it
// has one.
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

// Score every prior falsifier against TODAY's panels. Every falsifier written
// before 2026-07-27 carried a free-text magnitude and resolves as UNCHECKABLE,
// which is the honest starting point: the record begins now rather than being
// backfilled with predictions nobody could evaluate.
const falsifierRecord = resolveOutstanding(runs, payload, nowIso());

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
    // No divergence to record. This verdict IS the mechanical one — no model ran, so
    // there is no independent reading for it to differ from, and computing a
    // comparison of the mechanics against themselves would always return agreement
    // and make the record look better corroborated than it is.
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
    messages: [{ role: "user", content: buildPass1Message(payload, changes, news.text, !priorEntry, nowIso().slice(0, 10)) }],
  };
}
function pass2Request(model, pass1) {
  return {
    model,
    max_tokens: MAX_TOKENS,
    thinking: { type: "adaptive" },
    output_config: { effort: EFFORT },
    // The first-run addendum appends itself only when there is genuinely no prior
    // entry, and drops off by itself from run two. Pass 2 is built to reconcile
    // against a previous verdict; with none, it would either invent a comparison or
    // spend the reader's opening paragraph explaining that the archive is empty,
    // which is a fact about our deployment rather than about the labour market.
    system: priorEntry ? PASS2_SYSTEM : PASS2_SYSTEM + FIRST_RUN_ADDENDUM,
    messages: [{ role: "user", content: buildPass2Message(pass1, priorEntry, changes, falsifierRecord) }],
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
  console.log(`falsifiers       : ${falsifierRecord.summary}`);
  for (const r of falsifierRecord.resolutions) {
    console.log(`  ${r.dataMonth} ${r.verdict}: ${r.outcome} — ${r.reason}`);
  }
  console.log(`paired state     : ${paired.state} (${paired.attribution.label} + ${paired.reabsorption.label}) — NOT sent to the model`);
  console.log(`  attribution    : z ${paired.attribution.z ?? "cannot be placed"} (line ${paired.attributionLineZ})`);
  console.log(`  reabsorption   : ${paired.reabsorption.employmentFalling ?? "cannot be placed"} = 12-month FALL in prime-age employment (line ${paired.reabsorptionLine})`);
  console.log(`  path length    : ${paired.path.length} months`);
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
    fullAnalysis: pass2.fullAnalysis,
    compliance: noteCompliance(pass2.publishedNote),
    analysisStats: analysisCompliance(pass2.fullAnalysis),
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
      console.log(`divergence  : ${computeDissent(r.pass1.verdict) ?? "none — both mechanical readings agree"}`);
      // Counts are DESCRIPTIVE now. Length is proportional to what changed and the
      // number ceiling is retired, so there is no band to be outside of.
      console.log(`note        : ${r.compliance.words} words (${r.compliance.lengthBand}), ${r.compliance.numbers} numbers`);
      console.log(`full analysis: ${r.analysisStats.present ? `${r.analysisStats.words} words` : "ABSENT"}`);
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

/**
 * Keep only names that are real panels, and only ones entitled to carry a verdict.
 *
 * TWO FILTERS, BOTH NECESSARY. A name the payload does not contain is a
 * misremembering, and passing it through would leave the widget silently selecting
 * nothing — the failure would look like the feature not working rather than like bad
 * input, so it is logged. And a panel whose role says it contributes nothing must not
 * become a home-screen chart labelled as what the verdict rests on, whatever the model
 * says: the prompt tells it not to, and a rule the code can enforce should not be left
 * to instruction-following.
 */
function validLoadBearing(names) {
  const byName = new Map(payload.map((p) => [p.panel, p]));
  const kept = [];
  for (const n of names) {
    const panel = byName.get(n);
    if (!panel) {
      console.warn(`WARN load-bearing panel "${n}" is not in the payload; ignoring`);
      continue;
    }
    if (panel.panel_role === "does_not_contribute") {
      console.warn(`WARN load-bearing panel "${n}" contributes nothing by role; ignoring`);
      continue;
    }
    kept.push(n);
  }
  return kept;
}

const loadBearingPanels = validLoadBearing(result.pass1.loadBearingPanels ?? []);

appendEntry(
  {
    date: dataMonth,
    runAt: result.finishedAt,
    // Which panels the analyst says the reading rests on. The widget shows these
    // instead of guessing from whichever panel sits furthest from its baseline.
    loadBearingPanels,
    verdict: result.pass1.verdict,
    // Rated in pass 1, committed with the verdict and before pass 2 writes a word a
    // reader sees. Rating it afterwards would let the write-up talk itself into a
    // confidence the blind read never had.
    confidence: result.pass1.confidence,
    confidenceBasis: result.pass1.confidenceBasis,
    tagLine: result.pass2.tagLine,
    notificationLine: result.pass2.notificationLine,
    confoundedPathway: result.pass1.verdict === "CONFOUNDED" ? "analyst" : null,
    namedConfounder: result.pass1.confounder,
    falsifier: result.pass1.falsifier,
    falsifierPlain: result.pass1.falsifierPlain,
    // Computed from the finished verdict against readings the model never saw, not
    // asked of the model. See computeDissent.
    dissent: computeDissent(result.pass1.verdict),
    analysis: result.text,
    // The longer document, shown behind the "Full analysis" control. NOT the
    // reasoning log, which stays out of the app entirely.
    fullAnalysis: result.fullAnalysis,
    compliance: result.compliance,
    analysisStats: result.analysisStats,
  },
  result,
);

console.log(
  `analyst: ${result.pass1.verdict} "${result.pass2.tagLine}" (${dataMonth}); ` +
  `mechanical ${mechanical.mechanicalState}` +
  (computeDissent(result.pass1.verdict) ? "; DIVERGES FROM THE MECHANICS" : "") +
  `; note ${result.compliance.words}w (${result.compliance.lengthBand})/${result.compliance.numbers}n` +
  `; analysis ${result.analysisStats.present ? `${result.analysisStats.words}w` : "ABSENT"}` +
  ` — usage (log only): ${result.usage.totalInputTokens} in / ${result.usage.totalOutputTokens} out, ` +
  `est $${result.usage.costUsd.toFixed(4)}`,
);

/**
 * Whether the mechanical 2x2 lands in the same place the analyst did. Returns a
 * string rather than a boolean because "cannot be compared" is a real third
 * answer: CONFOUNDED is off the axis by design and INDETERMINATE means an axis
 * had no clean baseline, and collapsing either into "disagrees" would manufacture
 * a dissent that nobody asserted.
 */
function agreementWith(state, verdict) {
  if (state === "INDETERMINATE" || verdict === "CONFOUNDED") return "not comparable";
  const impliedByState = {
    DISPLACEMENT: "DISPLACEMENT",
    REALLOCATION: "AUGMENTATION",  // work moving, aggregate catching it
    STABLE: "AUGMENTATION",        // nothing deteriorating anywhere
    NOT_AI: "CONFOUNDED",          // weakness with no AI-exposed signature
  }[state];
  return impliedByState === verdict ? "agrees" : "diverges";
}

/**
 * The same comparison against the older rule-based chain.
 *
 * MIXED_TRANSITIONING is deliberately not comparable rather than mapped to a side.
 * It is the chain's explicit fence — the bucket it lands in when one signal fires,
 * or when a gate holds a BREAK back — so forcing it onto AUGMENTATION or
 * DISPLACEMENT would manufacture an agreement or a disagreement that the rule never
 * asserted, and the whole value of this record is that it only reports differences
 * somebody actually took a position on.
 */
function chainAgreementWith(mechanicalVerdict, verdict) {
  const implied = {
    AUGMENTATION_HOLDING: "AUGMENTATION",
    DISPLACEMENT_EMERGING: "DISPLACEMENT",
    CONFOUNDED: "CONFOUNDED",
  }[mechanicalVerdict];
  if (!implied) return "not comparable";
  return implied === verdict ? "agrees" : "diverges";
}

/**
 * DISSENT, COMPUTED — never asked for and never self-reported.
 *
 * Pass 2 used to be asked whether it disagreed with pass 1, and the answer was
 * written here. That question is gone: a model holding a candidate answer and asked
 * to endorse it takes the cheap path and assembles support, which is the exact
 * failure the blind first pass exists to prevent. So the divergence is measured
 * after both readings exist, in code, from values neither pass ever saw.
 *
 * NEITHER MECHANICAL READING IS AN ANSWER KEY, and the wording here has to keep
 * saying so. The four-corner grid especially is one chart among many and a noisy
 * one: its horizontal axis has not changed quadrant in years, so its colour is
 * decided almost entirely by a single economy-wide series crossing zero, which it
 * did eight times in the last eighteen months. A verdict that differs from it has
 * not thereby been graded wrong. Both are computed on the same data by different
 * routes, and the difference is the thing worth recording.
 *
 * Returns null when nothing diverges, so the app's dissent block stays absent
 * rather than rendering a paragraph that says everything agreed.
 */
function computeDissent(verdict) {
  const vsGrid = agreementWith(paired.state, verdict);
  const vsChain = chainAgreementWith(mechanical.verdict, verdict);
  const diverging = [];
  if (vsGrid === "diverges") {
    diverging.push(
      `the four-corner grid places this month at ${paired.state} ` +
      `(${paired.attribution.label}, ${paired.reabsorption.label})`,
    );
  }
  if (vsChain === "diverges") {
    diverging.push(
      `the rule-based chain reads ${mechanical.mechanicalState} ` +
      `with ${mechanical.breadth} of three differentials firing`,
    );
  }
  if (diverging.length === 0) return null;
  return (
    `The analyst read ${verdict} from the panels without being shown either mechanical ` +
    `reading, and ${diverging.join(", while ")}. ` +
    `Recorded, not resolved: these are different routes through the same data, and ` +
    `neither one overrules the other. The grid in particular turns on a single ` +
    `economy-wide series sitting near zero, so a month's disagreement with it is ` +
    `ordinary rather than a mark against either reading.`
  );
}

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
    // The paired state, stored with the run and never shown to the model. The
    // path is kept out of the timeline entry (the app recomputes it from the pool
    // for the 2x2 chart); only the placement is logged, so the log stays small
    // while still recording what the mechanics said this month.
    pairedState: {
      state: paired.state,
      attributionZ: paired.attribution.z,
      attributionLabel: paired.attribution.label,
      // The reabsorption axis has no z. It is a 12-month CHANGE read against raw
      // zero, deliberately, so there is no distribution to score against and no
      // field called `z` on that object — this line read `paired.reabsorption.z`
      // and had therefore been logging `undefined` in every entry since the axis
      // was re-registered. Named for what it actually is.
      reabsorptionEmploymentFalling: paired.reabsorption.employmentFalling,
      reabsorptionLabel: paired.reabsorption.label,
    },
    // Divergence is the reviewable signal: the analyst reasoned over the same two
    // axes without being told the answer, so a mismatch is worth looking at in
    // either direction. Recorded as a flag rather than a judgement.
    pairedStateAgreesWithVerdict: agreementWith(paired.state, entry.verdict),
    // Both mechanical readings are recorded side by side and neither is privileged.
    // The grid is the newer discriminator and the chain is the older stoplight; they
    // can disagree with the analyst and with each other, and which of the three is
    // right on any given month is not something this file is entitled to decide.
    chainAgreesWithVerdict: chainAgreementWith(mechanical.verdict, entry.verdict),
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

  // Reasoning log and published note as files, per run. Both kept: the gap
  // between them is the thing worth reviewing.
  if (result) {
    mkdirSync(TRANSCRIPT_DIR, { recursive: true });
    const stem = `${dataMonth}_${String(entry.runAt).replace(/[:.]/g, "-")}`;
    writeFileSync(
      path.join(TRANSCRIPT_DIR, `${stem}.reasoning.md`),
      [
        `# Reasoning log ${dataMonth} (run ${entry.runAt})`,
        ``,
        `Model: ${result.model} | effort: ${result.effort} | verdict: ${entry.verdict}`,
        `Input snapshot: ${inputHash}`,
        `Mechanical indicator, never shown to the model: ${mechanical.mechanicalState}, breadth ${mechanical.breadth}`,
        `Paired state, never shown to the model: ${paired.state} ` +
          `(${paired.attribution.label} z=${paired.attribution.z ?? "n/a"} + ` +
          `${paired.reabsorption.label} z=${paired.reabsorption.z ?? "n/a"}) ` +
          `— ${agreementWith(paired.state, entry.verdict)} with the published verdict`,
        ``,
        `Stored, never published. Pass 1 full working.`,
        ``,
        `---`,
        ``,
        result.pass1.reasoningLog,
      ].join("\n") + "\n",
      "utf8",
    );
    writeFileSync(
      path.join(TRANSCRIPT_DIR, `${stem}.note.md`),
      [
        `# Published note ${dataMonth} (run ${entry.runAt})`,
        ``,
        `Verdict: ${entry.verdict} | ${entry.compliance?.words ?? "?"} words (${entry.compliance?.lengthBand ?? "?"}) | ${entry.compliance?.numbers ?? "?"} numbers`,
        `Counts are reported, not enforced: length is proportional to what changed and the number ceiling is retired.`,
        `Notification: ${entry.notificationLine}`,
        `Falsifier: ${entry.falsifierPlain ?? "(none)"}`,
        ``,
        `---`,
        ``,
        entry.analysis,
      ].join("\n") + "\n",
      "utf8",
    );
    // The full analysis as its own file. Three documents, three files: the note is
    // what most readers see, this is what the "Full analysis" control opens, and the
    // reasoning log is the audit trail that is never surfaced to a reader. Keeping
    // them separate on disk is what makes the gap between them reviewable.
    if (entry.fullAnalysis) {
      writeFileSync(
        path.join(TRANSCRIPT_DIR, `${stem}.analysis.md`),
        [
          `# Full analysis ${dataMonth} (run ${entry.runAt})`,
          ``,
          `Verdict: ${entry.verdict} | ${entry.analysisStats?.words ?? "?"} words`,
          `Reader-facing. The same argument as the published note, developed at length.`,
          `This is NOT the reasoning log — see ${stem}.reasoning.md for that.`,
          ``,
          `---`,
          ``,
          entry.fullAnalysis,
        ].join("\n") + "\n",
        "utf8",
      );
    } else {
      console.warn(
        "WARN pass 2 returned no FULL_ANALYSIS block. The note and notification are " +
        "unaffected and the run still publishes; the app's Full analysis control will " +
        "be hidden for this month.",
      );
    }
  }
  writeFileSync(
    RUNS_PATH,
    JSON.stringify(
      {
        schemaVersion: runsLog.schemaVersion ?? 1,
        description: runsLog.description,
        lastRefreshed: entry.runAt,
        runs: [
          ...runs.map((r) => {
            const res = falsifierRecord.resolutions.find((x) => x.runAt === r.runAt);
            if (!res || res.outcome === "NOT_YET_DUE") return r;
            const { runAt, dataMonth, verdict, ...outcome } = res;
            return { ...r, falsifierResolution: outcome };
          }),
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
            fullAnalysisStats: entry.analysisStats,
            namedConfounder: entry.namedConfounder,
            mechanicalState: mechanical.mechanicalState,
            breadth: mechanical.breadth,
            gainsVisible: mechanical.gainsVisible,
            // Full paired state INCLUDING the 24-month path in the audit record.
            // The audit log is where a later reader reconstructs what the mechanics
            // saw, and a path shows movement between quadrants that a single
            // placement cannot.
            pairedState: paired,
            pairedStateAgreesWithVerdict: agreementWith(paired.state, entry.verdict),
            chainAgreesWithVerdict: chainAgreementWith(mechanical.verdict, entry.verdict),
            computedDissent: entry.dissent ?? null,
            // Opened unresolved; a later run settles it. Storing the slot now means
            // the shape is present from the first run rather than appearing later
            // and making early runs look like they were never scored.
            falsifierResolution: { outcome: "NOT_YET_DUE", reason: "registered this run" },
            falsifierRecordAtRun: falsifierRecord.tally,
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
                  pass1: { verdict: result.pass1.verdict, confidence: result.pass1.confidence, confidenceBasis: result.pass1.confidenceBasis, falsifier: result.pass1.falsifier, falsifierPlain: result.pass1.falsifierPlain, reasoningLog: result.pass1.reasoningLog, raw: result.rawPass1 },
                  pass2: { tagLine: result.pass2.tagLine, notificationLine: result.pass2.notificationLine, publishedNote: result.pass2.publishedNote, fullAnalysis: result.pass2.fullAnalysis, raw: result.rawPass2 },
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
    confidence: entry.confidence,
    confidenceBasis: entry.confidenceBasis,
    tagLine: entry.tagLine,
    notificationLine: entry.notificationLine,
    falsifier: entry.falsifierPlain,
    confoundedPathway: entry.confoundedPathway,
    namedConfounder: entry.namedConfounder,
    mechanicalState: mechanical.mechanicalState,
    breadth: mechanical.breadth,
    text: entry.analysis,
    fullAnalysis: entry.fullAnalysis,
    inputsFingerprint: inputHash,
    // THE ACTUAL INSTRUCTIONS, shipped so a reader can check them.
    //
    // A verifier's first fair question about an AI-written verdict is whether the
    // question was rigged — whether the prompt tells it what to conclude. The only
    // answer that settles it is the text itself, so the app carries it.
    //
    // Published FROM THE RUN rather than copied into the app, which is the whole
    // point: this is the exact string that produced the verdict above it, so the two
    // cannot drift. A copy pasted into the client would be a claim about the prompt;
    // this is the prompt.
    // The addendum ships as its OWN field rather than pre-concatenated into
    // promptPass2. The first run tells the analyst it has no prior run to compare
    // against, which is true once and then never again, so a reader who opened the
    // app on week one would otherwise see a prompt that is not the prompt the next
    // verdict gets. Split, promptPass2 is the every-run text — which is also
    // exactly what next week will be sent — and the addendum is visibly labelled as
    // applying to this run only. Concatenate the two to reconstruct what was
    // actually sent; the app says so where it prints them.
    promptPass1: PASS1_SYSTEM,
    promptPass2: PASS2_SYSTEM,
    promptPass2FirstRunAddendum: priorEntry ? "" : FIRST_RUN_ADDENDUM,
    promptModel: result?.model ?? null,
    promptEffort: result?.effort ?? null,
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
