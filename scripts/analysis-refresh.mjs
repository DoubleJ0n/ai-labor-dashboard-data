// Designed with Claude (Anthropic)
// analysis-refresh: produces the synthesized, plain-language read of the
// whole dashboard in the Mass-Labor-Displacement vs Augmented-Work frame.
// Rewrites ONLY the "analysis" section.
//
// MODEL: Sonnet 5 (claude-sonnet-5). HARD CONSTRAINTS honored here:
//  - the ACTUAL current dashboard numbers are passed into the prompt and the
//    model is told to reason ONLY from supplied data, never training recall;
//  - a few hundred words, plain no-insider-jargon voice;
//  - runs weekly but ONLY calls the model if FRED or discovery changed
//    something meaningful since the last analysis (inputsFingerprint gate);
//    otherwise keeps the prior text and updates the timestamp only.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { loadPool, saveSection, nowIso } from "./lib.mjs";
import { computeDashboardSummary } from "./metrics.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function readJson(rel) {
  try { return JSON.parse(readFileSync(path.join(repoRoot, rel), "utf8")); } catch { return null; }
}

const MODEL = "claude-sonnet-5";
// Sticker pricing $3 / $15 per MTok (matches the estimate style the app used).
const INPUT_USD_PER_TOKEN = 3 / 1_000_000;
const OUTPUT_USD_PER_TOKEN = 15 / 1_000_000;

const pool = loadPool();
const analysis = pool.analysis;

function bumpTimestampOnly(reason) {
  console.log(`analysis: ${reason}; keeping prior text, updating timestamp only`);
  analysis.lastRefreshed = nowIso();
  saveSection("analysis", analysis);
}

if (!pool.fred.lastRefreshed || Object.keys(pool.fred.series ?? {}).length === 0) {
  bumpTimestampOnly("no FRED data in the pool yet");
  process.exit(0);
}

// Read the separate METR + adoption snapshots so the analysis reviews EVERYTHING.
const metrSnap = readJson("data/metr/time_horizons.json");
const adoptionSnap = readJson("data/adoption/ai_adoption.json");
const summary = computeDashboardSummary(pool, {
  metrRecords: metrSnap?.records ?? [],
  adoptionPoints: adoptionSnap?.points ?? [],
});

// Meaningful-change gate: fingerprint the rounded inputs so float jitter or a
// mere re-download of identical data never triggers a paid model call.
const round = (v) => (typeof v === "number" ? Math.round(v * 100) / 100 : v);
const fingerprintInput = JSON.stringify(summary, (k, v) => round(v));
const fingerprint = createHash("sha256").update(fingerprintInput).digest("hex");

if (fingerprint === analysis.inputsFingerprint && analysis.text) {
  bumpTimestampOnly("inputs unchanged since last analysis");
  process.exit(0);
}

const fmt = (v, digits = 2) => (v == null ? "n/a" : v.toFixed(digits));

const dataBlock = `
Latest computed US labor-market and AI-capability indicator values:

PRODUCTIVITY (real GDP per worker proxy):
- trailing annualized growth: ${fmt(summary.productivity.growthPct)}%/yr (calibration band: ${summary.productivity.bandLowPct}%/yr was the 1995-2006 internet-boom average; ${summary.productivity.bandHighPct}%/yr would clearly exceed the internet boom)
- above the ${summary.productivity.bandHighPct}% upper bar: ${summary.productivity.flagged}

LEADING INDICATOR SECTORS (employment indexed to 100 at each sector's post-2021 peak):
${summary.sectors.map((s) => `- ${s.name}: level ${fmt(s.level)}, 6-month change ${fmt(s.delta6mo)} index points`).join("\n")}

RECENT-GRAD GAP (unemployment rate of recent college graduates aged 20-24 minus the general unemployment rate):
- current gap: ${fmt(summary.inversion.gapPct)} percentage points
- gap above its own trailing 10-year average: ${summary.inversion.anomalous}
- consecutive months with grads above the general rate: ${summary.inversion.runMonths}

GDP-EMPLOYMENT GROWTH GAP (real GDP growth minus payroll growth, year over year):
- current gap: ${fmt(summary.gdpEmployment.gapPct)} percentage points
- 10-year average gap: ${fmt(summary.gdpEmployment.avgGapPct)} percentage points

EXPOSED-vs-CONTROL JOBS (the confounder-robust test — a recession moves both together, so only an AI-shaped shock moves the difference):
- AI-exposed industries growing ${fmt(summary.exposedControl.exposedYoY)}%/yr vs control industries ${fmt(summary.exposedControl.controlYoY)}%/yr
- differential (exposed minus control): ${fmt(summary.exposedControl.differential)} percentage points (negative = exposed weakening relative to control)

LABOR SHARE OF INCOME (displacement theory predicts this FALLS; augmentation does not):
- latest index: ${fmt(summary.laborShare.latest)}, change over the last year: ${fmt(summary.laborShare.changeVs4qAgo)} index points

HIRING FLOWS in exposed sectors (the "quiet non-replacement" tell = openings/hires falling while layoffs stay flat):
- job openings rate ${fmt(summary.hiringFlows.openingsRate)}%, hires rate ${fmt(summary.hiringFlows.hiresRate)}% (year-over-year change ${fmt(summary.hiringFlows.hiresChangeYoY)} pts), layoffs rate ${fmt(summary.hiringFlows.layoffsRate)}%

AI ADOPTION (Census survey — the deciding evidence that AI is actually being deployed):
- ${summary.adoption ? `${fmt(summary.adoption.latestPct, 1)}% of firms use AI in some business function, ${summary.adoption.rising ? "rising" : "flat"}` : "no data"}

MACRO REGIME (context to separate an AI story from an ordinary business cycle):
- 10-year real interest rate ${fmt(summary.macro.realYield10y)}%, yield curve (10y minus 2y) ${fmt(summary.macro.termSpread10y2y)}%, expected inflation ${fmt(summary.macro.breakeven10y)}%
- yield curve inverted (a conventional recession signal): ${summary.macro.recessionSignal}

AI CAPABILITY — task-length horizons (METR; how long a task, in human working minutes, AI completes at 50% / 80% reliability), top models by 80% horizon:
${summary.metrTop5.map((m) => `- ${m.model} (${m.lab}): 80% horizon ${fmt(m.p80Min, 0)} min, 50% horizon ${fmt(m.p50Min, 0)} min`).join("\n")}

AI CAPABILITY — normalized benchmark tracks (0-100):
${summary.slots.map((s) => `- ${s.slot} (${s.benchmarkName}${s.saturated ? ", flagged as nearing saturation" : ""}): latest score ${fmt(s.latestScore, 0)} on ${s.latestDate ?? "n/a"}`).join("\n")}
`.trim();

const instruction = `
You are writing the weekly synthesis for a dashboard that tracks whether AI is
starting to displace human work at scale. Interpret the numbers above using two
competing frames: (1) Mass Labor Displacement — AI capability improves fast
enough to displace large categories of work discontinuously; (2) Augmented
Work — AI mostly helps people work better, and the big aggregate statistics
move slowly.

Weigh ALL the panels together, not just a few. Capability climbing while labor
indicators stay calm favors augmentation (or means displacement hasn't arrived
yet); labor indicators firing together WITH real AI adoption is the displacement
pattern. Give special weight to the EXPOSED-vs-CONTROL differential and to
ADOPTION: broad labor weakness alone is usually just the business cycle, but
exposed work weakening RELATIVE to control, while firms are actually deploying
AI, is the AI-specific fingerprint. Use the MACRO REGIME to check yourself — if
the yield curve is inverted, an ordinary recession is the more likely story.

Always account for the confounder: the post-2021 tech-hiring correction plus
ordinary economic cooling mimics early AI displacement in the exposed sectors.
State plainly which indicators look elevated, which don't, and the most likely
non-AI explanation for anything elevated.

This is your INDEPENDENT read. The app also shows a separate mechanical
indicator computed by a fixed rule; your job is to look at the whole picture
like an analyst and say where you think the evidence points — you may agree or
disagree with a mechanical reading.

STRICT RULES:
- Use ONLY the numbers supplied above. Do not bring in any statistic, event,
  or figure from memory. If a number is "n/a", say the data is missing rather
  than guessing.
- Write a few hundred words (roughly 250-400) in plain language for a smart
  reader with no economics or AI background: no acronyms without spelling them
  out, no data-series codes, no researcher names, no jargon.
- End with exactly one line: REGIME SIGNAL: NONE / AMBIGUOUS / PARTIAL / FIRING
  (this is your independent lean toward augmentation (NONE) vs displacement (FIRING)).
`.trim();

const client = new Anthropic(); // reads ANTHROPIC_API_KEY

let message;
try {
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 6000,
    messages: [{ role: "user", content: `${dataBlock}\n\n${instruction}` }],
  });
  message = await stream.finalMessage();
} catch (err) {
  // API failure (billing, outage, rate limit): keep the prior analysis
  // section completely untouched — no timestamp bump, so the pool honestly
  // reports when the analysis last actually refreshed. Exit non-zero so the
  // Actions run is visibly red.
  console.error("analysis call failed; prior analysis left untouched:", err.message ?? err);
  process.exit(1);
}

const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
if (!text) {
  console.error("analysis: model returned no text; keeping prior analysis");
  bumpTimestampOnly("empty model response");
  process.exit(0);
}

// Parse the machine-readable signal line (same rule as the app's RegimeSignal.parse).
const signalLine = text.split("\n").reverse().find((l) => l.toUpperCase().includes("REGIME SIGNAL"));
const signal = ["NONE", "AMBIGUOUS", "PARTIAL", "FIRING"]
  .find((s) => signalLine?.toUpperCase().includes(s)) ?? "UNKNOWN";

const inputTokens = message.usage.input_tokens ?? 0;
const outputTokens = message.usage.output_tokens ?? 0;

saveSection("analysis", {
  lastRefreshed: nowIso(),
  text,
  signal,
  model: MODEL,
  inputTokens,
  outputTokens,
  estimatedCostUsd: inputTokens * INPUT_USD_PER_TOKEN + outputTokens * OUTPUT_USD_PER_TOKEN,
  inputsFingerprint: fingerprint,
});
console.log(`analysis section updated (signal: ${signal}, ${outputTokens} output tokens)`);
