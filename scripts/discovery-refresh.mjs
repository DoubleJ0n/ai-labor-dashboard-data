// Designed with Claude (Anthropic)
// discovery-refresh: Claude WITH WEB SEARCH checks (1) newly published METR
// task-length-horizon results and (2) whether any tracked capability
// benchmark (reasoning/coding/biology) has saturated and needs a successor,
// per the M-V6 selection rules. Rewrites ONLY the "capability" section.
//
// MODEL: Haiku 4.5 (claude-haiku-4-5-20251001) — this is data extraction;
// deliberately not a bigger model. Haiku 4.5 uses the basic
// web_search_20250305 server tool (the _20260209 variant needs newer models).
import Anthropic from "@anthropic-ai/sdk";
import { loadPool, saveSection, nowIso, todayIsoDate, extractFencedJson } from "./lib.mjs";

const MODEL = "claude-haiku-4-5-20251001";
const MAX_PAUSE_CONTINUATIONS = 5;

const client = new Anthropic(); // reads ANTHROPIC_API_KEY

function buildPrompt(currentSlots) {
  return `
You maintain the capability data for a small AI-labor-market dashboard app.
Use web search to check two things, then reply with ONLY a fenced JSON block.

TASK 1 — METR time horizons. Find METR's (metr.org) most recent published
"task-completion time horizon" results. List EVERY model METR has actually
published BOTH or either of: 50% horizon and 80% horizon (in minutes), with
the model's public release date and the URL of the METR page/paper you got
the number from. Do NOT estimate or extrapolate a horizon for any model METR
has not measured. If METR has published nothing new since your data would
suggest, set changed=false.

TASK 2 — benchmark slots. The app shows one normalized 0-100 chart with three
slots: reasoning, coding, biology. Current slots: ${currentSlots}.
For each slot, verify the benchmark still meets these rules, or pick a better
one that does: (1) standardized, widely reported, peer-reviewed or equivalent;
(2) NOT yet saturated — meaningful headroom remains (if saturated, flag it and
prefer a successor); (3) for biology, use RESEARCH-capability benchmarks
(protocol debugging, sequence analysis, literature synthesis, e.g.
LAB-Bench-style) — NEVER biosecurity/threat/weaponization benchmarks.
For each slot give 3-8 dated score points (0-100) for frontier models over
time, each from a source you actually found, with the source URL.

Reply with exactly one fenced block in this schema (no other prose after it):
\`\`\`json
{"changed": true,
 "metr": {"models": [{"name": "...", "release_date": "YYYY-MM-DD",
   "p50_minutes": 0, "p80_minutes": 0, "source_url": "..."}]},
 "slots": [{"slot": "reasoning", "benchmark": "...", "source_url": "...",
   "saturated": false, "note": "one plain-language sentence describing the benchmark",
   "points": [{"label": "model name (benchmark)", "date": "YYYY-MM-DD", "score": 0}]}],
 "summary": "one line describing what changed"}
\`\`\`
If nothing new was found for either task, reply with {"changed": false} in the
fenced block.
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

let response;
try {
  response = await runWithWebSearch(buildPrompt(currentSlots));
} catch (err) {
  // Keep existing data valid; record the failure and exit 0 so the commit
  // step still bumps nothing destructive. Retry happens next week.
  console.error("discovery call failed:", err.message ?? err);
  pushLog(capability, false, `failed: ${String(err.message ?? err).slice(0, 200)}`);
  capability.lastRefreshed = nowIso();
  saveSection("capability", capability);
  process.exit(0);
}

const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
const parsed = extractFencedJson(text);

if (!parsed) {
  console.log("no parseable JSON in discovery response; leaving data unchanged");
  pushLog(capability, false, "no parseable JSON in discovery response");
} else if (!parsed.changed) {
  console.log("discovery: nothing new found");
  pushLog(capability, false, "nothing new found");
} else {
  const summaryParts = [];

  // METR models — full replacement of the "metr" points when provided.
  const models = parsed.metr?.models ?? [];
  if (models.length > 0) {
    const pts = [];
    for (const m of models) {
      if (!m.name || !m.release_date) continue;
      const src = m.source_url || "metr.org";
      if (typeof m.p50_minutes === "number") {
        pts.push({ metricId: "metr", seriesKey: "p50", pointDate: m.release_date, label: m.name, value: m.p50_minutes, sourceUrl: src, fetchDate: today });
      }
      if (typeof m.p80_minutes === "number") {
        pts.push({ metricId: "metr", seriesKey: "p80", pointDate: m.release_date, label: m.name, value: m.p80_minutes, sourceUrl: src, fetchDate: today });
      }
    }
    if (pts.length > 0) {
      capability.points = capability.points.filter((p) => p.metricId !== "metr").concat(pts);
      summaryParts.push(`METR: ${pts.length} points`);
    }
  }

  // Benchmark slots + normalized points — full replacement when provided.
  const slots = parsed.slots ?? [];
  if (slots.length > 0) {
    const slotEntities = [];
    const pts = [];
    for (const s of slots) {
      if (!s.slot || !s.benchmark) continue;
      const src = s.source_url || "";
      slotEntities.push({
        slot: s.slot,
        benchmarkName: s.benchmark,
        sourceUrl: src,
        fetchDate: today,
        saturated: Boolean(s.saturated),
        note: s.note || "",
      });
      for (const p of s.points ?? []) {
        if (!p.label || !p.date || typeof p.score !== "number") continue;
        pts.push({ metricId: "normalized", seriesKey: s.slot, pointDate: p.date, label: p.label, value: p.score, sourceUrl: src, fetchDate: today });
      }
    }
    if (slotEntities.length > 0) {
      const bySlot = Object.fromEntries(slotEntities.map((s) => [s.slot, s]));
      capability.slots = capability.slots.map((s) => bySlot[s.slot] ?? s);
      for (const s of slotEntities) {
        if (!capability.slots.some((x) => x.slot === s.slot)) capability.slots.push(s);
      }
    }
    if (pts.length > 0) {
      capability.points = capability.points.filter((p) => p.metricId !== "normalized").concat(pts);
      summaryParts.push(`slots: ${slotEntities.length}, ${pts.length} points`);
    }
  }

  const summary = summaryParts.join("; ") || "changed=true but no usable data";
  console.log("discovery applied:", summary);
  pushLog(capability, summaryParts.length > 0, summary);
}

capability.lastRefreshed = nowIso();
saveSection("capability", capability);
console.log("capability section updated");
