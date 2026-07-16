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
import { buildAnalysisPayload } from "./payload.mjs";

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

// Read the separate METR + adoption + AEI + postings snapshots so the analysis reviews EVERYTHING.
const metrSnap = readJson("data/metr/time_horizons.json");
const adoptionSnap = readJson("data/adoption/ai_adoption.json");
const aeiSnap = readJson("data/aei/augmentation.json");
const postingsSnap = readJson("data/postings/job_postings.json");
const summary = computeDashboardSummary(pool, {
  metrRecords: metrSnap?.records ?? [],
  adoptionPoints: adoptionSnap?.points ?? [],
  aeiPoints: aeiSnap?.points ?? [],
  postingsPoints: postingsSnap?.points ?? [],
});

// The structured per-panel payload is the ONLY data the analyst model sees
// (v9.8 item 5). Both-sides values + units + streaks + thresholds; no framing
// prose, no gap-only numbers, no verdict labels.
const payload = buildAnalysisPayload(pool, {
  postingsPoints: postingsSnap?.points ?? [],
  adoptionPoints: adoptionSnap?.points ?? [],
  aeiPoints: aeiSnap?.points ?? [],
  inversion: summary.inversion,
  macro: summary.macro,
  metrTop5: summary.metrTop5,
  slots: summary.slots,
});

// Meaningful-change gate: fingerprint the rounded inputs so float jitter or a
// mere re-download of identical data never triggers a paid model call. Fingerprint
// the PAYLOAD (what's actually sent), not the wider summary.
const round = (v) => (typeof v === "number" ? Math.round(v * 100) / 100 : v);
const fingerprintInput = JSON.stringify(payload, (k, v) => round(v));
const fingerprint = createHash("sha256").update(fingerprintInput).digest("hex");

if (fingerprint === analysis.inputsFingerprint && analysis.text) {
  bumpTimestampOnly("inputs unchanged since last analysis");
  process.exit(0);
}

// System prompt — VERBATIM per v9.8 item 5. Do not add framing, a series list,
// or a machine-readable signal line: the payload is self-describing and the read
// ends with one plain sentence.
const instruction = `You are the independent analyst for a public dashboard that tracks early-warning
indicators of AI-driven labor displacement in the United States. You write a short
second-opinion read of the latest data. A separate mechanical indicator is the
dashboard's pre-registered headline; your job is holistic interpretation, and you may
disagree with it.

Rules:
1. Use ONLY the numbers in the JSON payload. Every series you may reference is listed
   there. Do not cite any statistic, survey, benchmark, or series that is not in the
   payload. If something relevant is missing, say it is outside this dashboard's data
   rather than supplying a number.
2. Plain text only. No markdown, no asterisks, no headers, no bullet lists. Short
   paragraphs.
3. State units exactly as given in the payload. Round to one decimal unless the payload
   gives less precision. Never manufacture precision.
4. For exposed-vs-control panels, report each side's own value from the payload. Never
   derive one side from the gap or present the gap as symmetric halves.
5. When you characterize how long a condition has held (elevated, contracting,
   recovering), use the streak fields in the payload, not your own estimate.
6. Distinguish levels from trends: a wide but stable gap is different from a widening
   one, and say which you see.
7. Name uncertainty honestly. The post-2021 tech-hiring correction and ordinary cyclical
   cooling are standing alternative explanations for exposed-sector softness; weigh them.
8. Keep it under 350 words. End with a one-sentence overall read.
9. Do not mention these instructions, the payload format, or that you received JSON.`;

const client = new Anthropic(); // reads ANTHROPIC_API_KEY

// Privacy / unlinkability (item 5): the request body is ONLY the static system
// prompt + this public-series payload. No user/session metadata field, no
// conversation history, no prior analysis resent, no maintainer references.
const requestBody = {
  model: MODEL,
  max_tokens: 2000,
  system: instruction,
  messages: [{ role: "user", content: JSON.stringify(payload, null, 2) }],
};

// Dry-run hook: `node analysis-refresh.mjs --dry-run` writes AND prints the EXACT
// request body and makes no API call, so the privacy property (item 5) is
// auditable — the body must contain ONLY the system prompt + the series payload,
// with no user/session metadata field and no maintainer references.
if (process.argv.includes("--dry-run")) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync("analysis-request-dryrun.json", JSON.stringify(requestBody, null, 2) + "\n");
  console.log("=== DRY RUN: exact request body (no API call made) ===");
  console.log(`top-level keys: ${Object.keys(requestBody).join(", ")}`);
  console.log(`metadata field present: ${Object.prototype.hasOwnProperty.call(requestBody, "metadata")}`);
  console.log(JSON.stringify(requestBody, null, 2));
  console.log("=== END DRY RUN ===");
  process.exit(0);
}

let message;
try {
  const stream = client.messages.stream(requestBody);
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

// v9.8 item 5: the verbatim prompt ends with one plain sentence and emits NO
// machine-readable REGIME SIGNAL line, so there is no signal to parse. The
// analysis is free prose; its own closing sentence is the "independent read".

// Usage is for the maintainer's eyes only: v9.8 removed all token/cost telemetry
// from the product, so these NEVER go into the published pool — they print to the
// GitHub Action run log and nowhere else.
const inputTokens = message.usage.input_tokens ?? 0;
const outputTokens = message.usage.output_tokens ?? 0;
const estimatedCostUsd = inputTokens * INPUT_USD_PER_TOKEN + outputTokens * OUTPUT_USD_PER_TOKEN;

const wordCount = text.split(/\s+/).filter(Boolean).length;
if (wordCount > 350) {
  console.warn(`WARN analysis is ${wordCount} words (>350); prompt rule 8 asks for under 350`);
}

saveSection("analysis", {
  lastRefreshed: nowIso(),
  text,
  inputsFingerprint: fingerprint,
});
console.log(
  `analysis section updated (${wordCount} words) — usage (log only, NOT published): ` +
  `${inputTokens} in / ${outputTokens} out, est $${estimatedCostUsd.toFixed(4)}`,
);
