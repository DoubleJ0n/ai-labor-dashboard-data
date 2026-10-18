// Designed with Claude (Anthropic)
// discovery-refresh: Claude WITH WEB SEARCH checks whether any tracked
// normalized-capability benchmark (reasoning/coding/biology) has saturated and
// needs a successor, per the M-V6 selection rules. Rewrites ONLY the
// "capability" slots + normalized points.
//
// NOTE: METR time horizons are NO LONGER handled here. That data has its own
// fetch job. This job only owns the normalized benchmark slots.
//
// MODEL: Haiku 4.5 (claude-haiku-4-5-20251001) — this is data extraction;
// deliberately not a bigger model. Haiku 4.5 uses the basic
// web_search_20250305 server tool (the _20260209 variant needs newer models).
//
// GOVERNANCE, revised 2026-08. audit-2026-07 finding 4 / C-3 put model-authored
// benchmark points behind a pull request for human review, and that gate is now
// removed along with the ones on adoption, AEI, GDPval and METR. The reason is that
// it was not being exercised: three proposals sat unread for up to a fortnight, the
// reviewer had no independent way to check them, and the adoption panel went stale
// waiting on a click that added nothing a parser had not already established. A gate
// nobody can act on is not oversight, it is latency wearing oversight's clothes.
//
// What replaces it is what was doing the real work anyway. Points are validated
// (0-100 range, date sanity, source URL required) and APPENDED with supersession
// marks, so the published history is never replaced wholesale; anything that fails
// validation is dropped and named; and every commit is revertible. A wrong number
// reaches readers and is wrong in public, which is the bargain the analyst's verdict
// already publishes under.
//
// ONE THING STILL STOPS THE JOB: a change to which benchmark fills a slot. See the
// halt further down for why that is a different kind of act from a wrong reading.
import { appendFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { loadPool, saveSection, nowIso, todayIsoDate, extractFencedJson } from "./lib.mjs";

const MODEL = "claude-haiku-4-5-20251001";
const MAX_PAUSE_CONTINUATIONS = 5;
const EARLIEST_POINT_DATE = "2015-01-01"; // sanity floor for model-supplied dates

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPORT_PATH = path.join(repoRoot, "discovery-report.md");

// The halt for a change of instrument (see below) is the only path that ends
// this job red; every other dead end is a nochange. Same shape as the fail() in
// gdpval/adoption/aei/metr-fetch.
function fail(msg) {
  console.error(`discovery-refresh FATAL: ${msg}`);
  process.exit(1);
}

function setOutput(key, value) {
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}<<EOF\n${value}\nEOF\n`);
  }
}

const client = new Anthropic(); // reads ANTHROPIC_API_KEY

function buildPrompt(currentSlots) {
  return `
You maintain the normalized-capability data for a small AI-labor-market
dashboard app. Use web search to check ONE thing, then reply with ONLY a
fenced JSON block.

Benchmark slots. The slots below are the COMPLETE list, and both the slots and
the benchmark filling each one are already chosen and are not yours to change:
${currentSlots}.
Do not add a slot, do not report on a subject that is not listed, and do not
reinstate one you may remember from an earlier version of this task. A slot
absent from that list was retired deliberately.

Your job is to find new dated scores ON THOSE EXACT BENCHMARKS. For each slot,
copy the registered benchmark name into "benchmark" verbatim, and give 3-8 dated
score points (0-100) for frontier models over time, each from a source you
actually found, with the source URL. A score measured on any other benchmark —
including a successor, a variant, or a "Pro"/"v2" edition of the same name — does
not belong in that slot and must be left out.

If you judge a registered benchmark saturated or superseded, say so in
"saturated" and name what you would replace it with in "successor_note". That is
REPORTED, NOT ACTED ON: a human decides whether the slot changes instrument,
because swapping it rewrites what the published history has been measuring.
Flagging it costs nothing and loses nothing; substituting it silently would.

Reply with exactly one fenced block in this schema (no other prose after it):
\`\`\`json
{"changed": true,
 "slots": [{"slot": "reasoning", "benchmark": "<the registered name, verbatim>",
   "source_url": "...", "saturated": false,
   "successor_note": "" or "what you would swap to, and why",
   "note": "one plain-language sentence describing the benchmark",
   "points": [{"label": "model name (benchmark)", "date": "YYYY-MM-DD", "score": 0}]}],
 "summary": "one line describing what changed"}
\`\`\`
If nothing new was found, reply with {"changed": false} in the fenced block.
`.trim();
}

async function runWithWebSearch(prompt) {
  let messages = [{ role: "user", content: prompt }];
  let finalMessage = null;
  for (let attempt = 0; attempt <= MAX_PAUSE_CONTINUATIONS; attempt++) {
    // Streaming keeps bytes flowing during long server-side search turns.
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 8000,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 6 }],
      messages,
    });
    finalMessage = await stream.finalMessage();
    if (finalMessage.stop_reason !== "pause_turn") return finalMessage;
    // Server-side tool loop paused — re-send with the assistant turn appended.
    messages = [...messages, { role: "assistant", content: finalMessage.content }];
  }
  return finalMessage;
}

const pool = loadPool();
const capability = pool.capability;
const today = todayIsoDate();
const currentSlots = capability.slots.map((s) => `${s.slot}=${s.benchmarkName}`).join(", ");

function pushLog(cap, foundNew, summary) {
  cap.log = [{ runDate: today, foundNew, summary }, ...(cap.log ?? [])].slice(0, 20);
}

function nochange(reason) {
  // No PR, no pool write: a failed or empty discovery run must not touch the
  // published data (the log entry rides in the next real change's PR).
  console.log(`discovery: ${reason} — nothing proposed`);
  setOutput("status", "nochange");
  process.exit(0);
}

let response;
try {
  response = await runWithWebSearch(buildPrompt(currentSlots));
} catch (err) {
  nochange(`call failed: ${String(err.message ?? err).slice(0, 200)}`);
}

const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
const parsed = extractFencedJson(text);

if (!parsed) nochange("no parseable JSON in discovery response");
if (!parsed.changed) nochange("nothing new found");

// --- Validate the model-authored data (finding 4: shape-only checks let a
// --- mis-scaled score, absurd date, or sourceless point publish). ---
const dropped = [];
const validPoint = (p, slot) => {
  if (!p.label || typeof p.score !== "number" || !Number.isFinite(p.score)) return "malformed";
  if (p.score < 0 || p.score > 100) return `score ${p.score} outside 0-100`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date ?? "")) return `bad date ${p.date}`;
  if (p.date < EARLIEST_POINT_DATE || p.date > today) return `implausible date ${p.date}`;
  if (!slot.source_url || !/^https?:\/\//.test(slot.source_url)) return "no source URL";
  return null;
};

// A SLOT THAT IS NOT REGISTERED IS NOT A SLOT.
//
// The merge below used to push any slot the model returned into capability.slots if it
// was not already there, which made a retirement unenforceable: the biology slot was
// retired on 2026-10-17 and a single run that still remembered it would have recreated
// it, note and all, with nobody having registered anything. Creating a slot is a human
// act for the same reason changing one's instrument is. Unregistered slots are reported
// in the PR body and otherwise ignored, points included.
const registeredSlots = new Set(capability.slots.map((x) => x.slot));
const unregisteredSlots = [];

const slotEntities = [];
const pts = [];
for (const s of parsed.slots ?? []) {
  if (!s.slot || !s.benchmark) continue;
  if (!registeredSlots.has(s.slot)) { unregisteredSlots.push(s.slot); continue; }
  const src = s.source_url || "";
  slotEntities.push({
    slot: s.slot,
    benchmarkName: s.benchmark,
    sourceUrl: src,
    fetchDate: today,
    saturated: Boolean(s.saturated),
    successorNote: s.successor_note || "",
    note: s.note || "",
  });
  for (const p of s.points ?? []) {
    const bad = validPoint(p, s);
    if (bad) { dropped.push(`${s.slot} / ${p.label ?? "?"} (${p.date ?? "?"}): ${bad}`); continue; }
    pts.push({ metricId: "normalized", seriesKey: s.slot, pointDate: p.date, label: p.label, value: p.score, sourceUrl: src, fetchDate: today });
  }
}

// --- Append with supersession — never replace the published history. ---
const existingNorm = capability.points.filter((p) => p.metricId === "normalized");
const keyOf = (p) => `${p.seriesKey}|${p.pointDate}|${p.label}`;
const byKey = new Map(existingNorm.map((p) => [keyOf(p), p]));
const added = [];
let supersededCount = 0;
for (const p of pts) {
  const existing = byKey.get(keyOf(p));
  if (existing && Math.abs(existing.value - p.value) < 1e-9) continue; // already published
  if (existing) { existing.superseded = true; supersededCount++; }
  added.push(p);
}

const benchmarkSwaps = slotEntities
  .filter((s) => capability.slots.some((x) => x.slot === s.slot && x.benchmarkName !== s.benchmarkName))
  .map((s) => `${s.slot}: ${capability.slots.find((x) => x.slot === s.slot).benchmarkName} -> ${s.benchmarkName}`);

// A NEW READING PUBLISHES ITSELF. A NEW INSTRUMENT DOES NOT.
//
// Everything else this job proposes is a score on a benchmark the app already
// tracks, and those now go straight to main: if a number is wrong it is wrong in
// public, which is the same bargain the analyst's verdict is published under.
//
// Swapping which benchmark fills a slot is a different act. It does not add a
// reading, it redefines what the chart has been measuring, and it does so
// retroactively: the published history was scored on the old benchmark and cannot
// be compared with the new one. That is not a claim that can be right or wrong in
// public, because the chart stops meaning one thing without saying so.
//
// So the job halts instead, the same way a GDPval pool roll halts, and for the same
// reason: a change of instrument is a re-registration, and re-registration is
// deliberate. It costs a red run and a config edit, and it happens about never.
//
// UPDATE 2026-10-16: "about never" was wrong — it was every single week, ten weeks
// running, with the identical diagnosis (coding: SWE-bench Verified -> SWE-bench Pro;
// biology: LAB-Bench -> LABBench2). Not drift, and not a bug either: the prompt USED to
// instruct the model to "pick a better one" and to "prefer a successor" when a benchmark
// looked saturated, while this block forbade exactly that. The job was told to do the one
// thing that halts it, so it halted, deterministically, and the weekly feed delivered
// nothing for ten weeks while looking like a recurring upstream emergency.
//
// The prompt now pins the instrument and routes a saturation judgement into
// "successor_note", which is reported and published without stopping anything. A swap
// reaching this point again therefore means the model ignored an explicit instruction,
// which IS the anomaly worth a red run. The guard is unchanged; what changed is that it
// is no longer the expected outcome.
if (benchmarkSwaps.length) {
  fail(
    `benchmark identity changed (${benchmarkSwaps.join("; ")}). This redefines what the ` +
      `slot has been measuring and breaks comparability with the published history, so it ` +
      `will not auto-publish. Decide whether the swap is right, and what happens to the ` +
      `existing points, then re-register the slot in dashboard-data.json before this job ` +
      `runs again.`,
  );
}

if (added.length === 0) {
  nochange(`no new data after validation${dropped.length ? ` (${dropped.length} points dropped: ${dropped.join("; ")})` : ""}`);
}

// THE REGISTRATION IS OWNED BY dashboard-data.json, NOT BY THE MODEL.
//
// This merge used to be `bySlot[s.slot] ?? s`, replacing the WHOLE slot object with the
// model's version. benchmarkName was protected by the swap guard above; sourceUrl and
// note were not, and on 2026-10-16 one run quietly rewrote both. A hand-pinned note
// recording WHY SWE-bench Pro must be read off the public standardized leaderboard was
// replaced by a one-line description, and the reasoning slot's official source
// (agi.safe.ai) became a Wikipedia article. For SWE-bench Pro the standardized and
// self-reported figures differ by about twenty points, so a drifting sourceUrl is the
// same class of error as a silent instrument swap, one field down — and it drifted
// without tripping anything, because nothing was watching that field.
//
// So the model contributes only what it actually observed: the points, and its
// saturation judgement. What the slot IS stays where a human put it.
for (const s of slotEntities) {
  const registered = capability.slots.find((x) => x.slot === s.slot);
  if (!registered) continue; // filtered above; belt and braces
  registered.saturated = s.saturated;
  registered.successorNote = s.successorNote;
  registered.fetchDate = s.fetchDate;
}
// existingNorm entries carry their supersession marks (mutated in place);
// the full normalized history is kept and the validated points appended.
capability.points = capability.points
  .filter((p) => p.metricId !== "normalized")
  .concat(existingNorm, added);

const summary = `+${added.length} points (${supersededCount} superseded${dropped.length ? `, ${dropped.length} dropped invalid` : ""})` +
  (benchmarkSwaps.length ? `; benchmark change: ${benchmarkSwaps.join(", ")}` : "");
pushLog(capability, true, summary);
capability.lastRefreshed = nowIso();
saveSection("capability", capability);

// --- PR report (reviewed by a human; the workflow never commits to main) ---
const title = `discovery: ${summary.slice(0, 80)}`;
const body = [
  `# Discovery proposal — ${today}`,
  "",
  "Model-authored benchmark data (Haiku 4.5 + web search). Review before merging:",
  "check each point against its source URL, and treat any benchmark-identity",
  "change as a re-registration of that slot.",
  "",
  `- Points added: ${added.length}`,
  ...added.map((p) => `  - ${p.seriesKey} | ${p.pointDate} | ${p.label} | ${p.value} | ${p.sourceUrl}`),
  `- Prior points marked superseded: ${supersededCount}`,
  ...(unregisteredSlots.length
    ? ["", "## Unregistered slots ignored",
       ...unregisteredSlots.map((x) => `- ${x} — not in the registration, so nothing was written for it`),
       "", "Registering a slot is a deliberate edit to dashboard-data.json. If one of these",
       "should exist, add it there; it will not appear because the model proposed it."]
    : []),
  ...(() => {
    // A saturation judgement is the thing most worth a human's eye and the thing
    // least worth a failed run, so it rides in the report rather than the exit code.
    const flagged = slotEntities.filter((s) => s.saturated || s.successorNote);
    return flagged.length
      ? ["", "## Saturation flagged (reported, not acted on)",
         ...flagged.map((s) => `- ${s.slot} = ${s.benchmarkName}${s.saturated ? " — flagged SATURATED" : ""}${s.successorNote ? `; suggested successor: ${s.successorNote}` : ""}`),
         "", "Changing a slot's instrument is a deliberate edit to dashboard-data.json.",
         "Nothing here has been applied."]
      : [];
  })(),
  ...(benchmarkSwaps.length ? ["", "## BENCHMARK IDENTITY CHANGES (extra scrutiny)", ...benchmarkSwaps.map((s) => `- ${s}`)] : []),
  ...(dropped.length ? ["", "## Dropped by validation", ...dropped.map((d) => `- ${d}`)] : []),
].join("\n");
writeFileSync(REPORT_PATH, body + "\n");
setOutput("status", "changes");
setOutput("title", title);
console.log(`discovery proposed: ${summary}`);
