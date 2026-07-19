// Designed with Claude (Anthropic)
// metr-fetch: pulls METR's published Time Horizon feed, normalizes it, and
// PROPOSES changes to the pinned snapshot (data/metr/time_horizons.json) as a
// pull request. It NEVER writes the snapshot in a way that auto-merges — the
// workflow opens a PR (for a human to review) or an issue, never a silent
// commit to the source of truth.
//
// This job is FREE (METR's YAML feed, no API key) and therefore runs even
// when the Anthropic account has no credits.
//
// Diff classification (the whole reason this pipeline exists — revisions to a
// metric you make decisions with are EVENTS, not maintenance):
//   NEW MODEL         -> feed model absent from snapshot. Append. Routine PR.
//   REVISION          -> p50/p80 of an existing model changed. PR, needs-review.
//   METHODOLOGY SHIFT -> feed exposes a new TH version. Issue, stop. Never merge
//                        a different task suite into the TH1.1 series.
//   NO CHANGE         -> exit 0, no PR, no noise.
//
// Failure behavior: 404 / unparseable / missing required field -> fail loudly.
// Never fall back to stale data silently, never write a partial snapshot.
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import YAML from "yaml";

const FEED_URL = "https://metr.org/assets/benchmark_results_1_1.yaml";
const EPS = 0.05; // minutes: below this a value diff is float noise, not a revision

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SNAPSHOT_PATH = path.join(repoRoot, "data", "metr", "time_horizons.json");
const REPORT_PATH = path.join(repoRoot, "metr-fetch-report.md");

// --- The explicit mapping layer. If METR renames a key upstream, the parser
// --- fails HERE (one known place) instead of silently corrupting a value. ---
const FIELD_MAP = {
  results: "results",
  benchmarkName: "benchmark_name",
  releaseDate: "release_date",
  metrics: "metrics",
  p50: "p50_horizon_length",
  p80: "p80_horizon_length",
  estimate: "estimate",
  ciLow: "ci_low",
  ciHigh: "ci_high",
  longTasksVersion: "long_tasks_version",
};

// Legacy sub-GPT-4 models METR still lists but that sit below the interesting
// range; not proposed as NEW MODEL to avoid noise.
const IGNORE_KEYS = new Set(["gpt2", "davinci_002", "gpt_3_5_turbo_instruct"]);

// Display name + lab for known feed keys. An unknown key is proposed with a
// humanized provisional name and lab "Unknown" so the PR asks for naming.
const MODEL_META = {
  claude_3_opus_inspect: ["Claude 3 Opus", "Anthropic"],
  claude_3_5_sonnet_20240620_inspect: ["Claude 3.5 Sonnet", "Anthropic"],
  claude_3_5_sonnet_20241022_inspect: ["Claude 3.5 Sonnet (new)", "Anthropic"],
  claude_3_7_sonnet_inspect: ["Claude 3.7 Sonnet", "Anthropic"],
  claude_4_opus_inspect: ["Claude Opus 4", "Anthropic"],
  claude_4_1_opus_inspect: ["Claude Opus 4.1", "Anthropic"],
  claude_opus_4_5_inspect: ["Claude Opus 4.5", "Anthropic"],
  claude_opus_4_6_inspect: ["Claude Opus 4.6", "Anthropic"],
  claude_mythos_preview_early_inspect: ["Claude Mythos Preview", "Anthropic"],
  gpt_4: ["GPT-4", "OpenAI"],
  gpt_4_1106_inspect: ["GPT-4 (Nov 2023)", "OpenAI"],
  gpt_4_turbo_inspect: ["GPT-4 Turbo", "OpenAI"],
  gpt_4o_inspect: ["GPT-4o", "OpenAI"],
  o1_preview: ["o1-preview", "OpenAI"],
  o1_inspect: ["o1", "OpenAI"],
  o3_inspect: ["o3", "OpenAI"],
  gpt_5_2025_08_07_inspect: ["GPT-5", "OpenAI"],
  gpt_5_1_codex_max_inspect: ["GPT-5.1-Codex-Max", "OpenAI"],
  gpt_5_2: ["GPT-5.2 (high)", "OpenAI"],
  gpt_5_3_codex: ["GPT-5.3-Codex (high)", "OpenAI"],
  gpt_5_4: ["GPT-5.4 (xhigh)", "OpenAI"],
  gemini_3_pro: ["Gemini 3 Pro", "Google"],
  gemini_3_1_pro: ["Gemini 3.1 Pro", "Google"],
};

function fail(msg) {
  console.error(`metr-fetch FATAL: ${msg}`);
  process.exit(1);
}

function setOutput(key, value) {
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}<<EOF\n${value}\nEOF\n`);
  }
}

function humanize(key) {
  return key.replace(/_inspect$/, "").replace(/_/g, " ");
}

function thVersionFromBenchmarkName(name) {
  // "METR-Horizon-v1.1" -> "1.1"
  const m = /v(\d+\.\d+)/.exec(name || "");
  return m ? m[1] : null;
}

function num(x) {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

async function fetchFeed() {
  let res;
  try {
    res = await fetch(FEED_URL, { headers: { Accept: "text/yaml, application/x-yaml, */*" } });
  } catch (e) {
    fail(`feed request threw: ${e.message ?? e}`);
  }
  if (!res.ok) fail(`feed HTTP ${res.status}`);
  const text = await res.text();
  let doc;
  try {
    doc = YAML.parse(text);
  } catch (e) {
    fail(`feed did not parse as YAML: ${e.message ?? e}`);
  }
  if (!doc || typeof doc !== "object") fail("feed parsed to a non-object");
  if (!doc[FIELD_MAP.results]) fail(`feed missing '${FIELD_MAP.results}' block (upstream rename?)`);
  return doc;
}

// Map one feed entry to the snapshot record shape, carrying forward metadata
// (vintage/flags/note/ci) from the existing record when present.
function mapEntry(metrKey, entry, existing, today) {
  const metrics = entry[FIELD_MAP.metrics];
  if (!metrics) fail(`model '${metrKey}' has no '${FIELD_MAP.metrics}' block`);
  const p50 = num(metrics[FIELD_MAP.p50]?.[FIELD_MAP.estimate]);
  const p80 = num(metrics[FIELD_MAP.p80]?.[FIELD_MAP.estimate]);
  if (p50 == null) fail(`model '${metrKey}' missing ${FIELD_MAP.p50}.${FIELD_MAP.estimate}`);
  const [name, lab] = MODEL_META[metrKey] ?? [humanize(metrKey), "Unknown"];
  return {
    metrKey,
    model: existing?.model ?? name,
    lab: existing?.lab ?? lab,
    releaseDate: entry[FIELD_MAP.releaseDate] ?? existing?.releaseDate ?? null,
    thVersion: existing?.thVersion ?? "1.1",
    p50Min: p50,
    p80Min: p80,
    ciLowMin: num(metrics[FIELD_MAP.p50]?.[FIELD_MAP.ciLow]) ?? existing?.ciLowMin ?? null,
    ciHighMin: num(metrics[FIELD_MAP.p50]?.[FIELD_MAP.ciHigh]) ?? existing?.ciHighMin ?? null,
    // A value moving is what we flag; stamp it as freshly published/post.
    metrPublishedDate: today,
    snapshotDate: today,
    vintage: `post_${today}`,
    flags: existing?.flags ?? [],
    note: existing?.note ?? null,
  };
}

function changed(a, b) {
  const d = (x, y) => (x == null || y == null ? x !== y : Math.abs(x - y) > EPS);
  return d(a.p50Min, b.p50Min) || d(a.p80Min, b.p80Min);
}

function pct(oldV, newV) {
  if (oldV == null || newV == null || oldV === 0) return "n/a";
  return `${(((newV - oldV) / oldV) * 100).toFixed(1)}%`;
}

// --- main ---
const today = new Date().toISOString().slice(0, 10);
const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
const bySnapKey = new Map(snapshot.records.filter((r) => r.metrKey).map((r) => [r.metrKey, r]));

const feed = await fetchFeed();
const feedThVersion = thVersionFromBenchmarkName(feed[FIELD_MAP.benchmarkName]);

// METHODOLOGY SHIFT: the feed is a different TH version than our primary series.
if (feedThVersion && feedThVersion !== snapshot.primaryThVersion) {
  const title = `METR METHODOLOGY SHIFT: feed is TH${feedThVersion}, snapshot is TH${snapshot.primaryThVersion}`;
  const body = [
    `# ${title}`,
    "",
    `METR's feed now reports **${feed[FIELD_MAP.benchmarkName]}** (TH${feedThVersion}). The pinned`,
    `snapshot tracks TH${snapshot.primaryThVersion}. A different task suite is a different ruler —`,
    "do NOT merge the two series. Decide whether to start a new TH-version series.",
    "",
    `Feed: ${FEED_URL}`,
  ].join("\n");
  writeFileSync(REPORT_PATH, body + "\n");
  setOutput("status", "methodology");
  setOutput("title", title);
  console.log(title);
  process.exit(0);
}

const newModels = [];
const revisions = [];
const feedKeys = Object.keys(feed[FIELD_MAP.results]);

for (const metrKey of feedKeys) {
  if (IGNORE_KEYS.has(metrKey)) continue;
  const entry = feed[FIELD_MAP.results][metrKey];
  const existing = bySnapKey.get(metrKey);
  const mapped = mapEntry(metrKey, entry, existing, today);
  if (!existing) {
    newModels.push(mapped);
  } else if (changed(existing, mapped)) {
    // Supersession mark (audit-2026-07 finding 18 / C-5): the snapshot itself
    // records that this point was revised, not just the PR that carried it.
    revisions.push({
      old: existing,
      next: { ...mapped, flags: [...new Set([...(mapped.flags ?? []), `revised_${today}`])] },
    });
  }
}

const feedVersionChanged =
  feed[FIELD_MAP.longTasksVersion] && feed[FIELD_MAP.longTasksVersion] !== snapshot.feedLongTasksVersion;

if (newModels.length === 0 && revisions.length === 0 && !feedVersionChanged) {
  setOutput("status", "nochange");
  console.log("metr-fetch: no change");
  process.exit(0);
}

// Apply: append new models, replace revised records in place, record feed version.
const updated = { ...snapshot, feedLongTasksVersion: feed[FIELD_MAP.longTasksVersion] ?? snapshot.feedLongTasksVersion };
updated.records = snapshot.records.map((r) => {
  const rev = revisions.find((x) => x.old.metrKey === r.metrKey);
  return rev ? rev.next : r;
});
updated.records.push(...newModels);
writeFileSync(SNAPSHOT_PATH, JSON.stringify(updated, null, 2) + "\n");

// Title: revisions are the headline case; otherwise a routine new-model add.
let title;
if (revisions.length > 0) {
  const r = revisions[0];
  title = `METR REVISION: ${r.old.model} p80 ${r.old.p80Min} -> ${r.next.p80Min}` +
    (revisions.length > 1 ? ` (+${revisions.length - 1} more)` : "");
} else if (newModels.length > 0) {
  const m = newModels[0];
  title = `METR: add ${m.model} (p50 ${m.p50Min}, p80 ${m.p80Min})` +
    (newModels.length > 1 ? ` (+${newModels.length - 1} more)` : "");
} else {
  title = "METR: feed version changed (no value diffs)";
}

const body = [];
body.push(`# ${title}`, "");
if (revisions.length > 0) {
  body.push(
    "## REVISIONS (needs-review)",
    "A published number changed. Confirm against METR's changelog before merging.",
    "",
    "| model | threshold | old | new | delta |",
    "|---|---|---|---|---|",
  );
  for (const { old, next } of revisions) {
    body.push(`| ${old.model} | p50 | ${old.p50Min} | ${next.p50Min} | ${pct(old.p50Min, next.p50Min)} |`);
    body.push(`| ${old.model} | p80 | ${old.p80Min ?? "null"} | ${next.p80Min ?? "null"} | ${pct(old.p80Min, next.p80Min)} |`);
  }
  body.push("", `METR changelog / feed: ${FEED_URL} and https://metr.org/time-horizons`, "");
}
if (newModels.length > 0) {
  body.push("## NEW MODELS", "");
  for (const m of newModels) {
    body.push(`- **${m.model}** (${m.lab}, released ${m.releaseDate}) — p50 ${m.p50Min}, p80 ${m.p80Min}` +
      (m.lab === "Unknown" ? ` — ⚠ set display name/lab (feed key \`${m.metrKey}\`)` : ""));
  }
  body.push("");
}
if (feedVersionChanged) {
  body.push(`Feed \`long_tasks_version\` changed: \`${snapshot.feedLongTasksVersion ?? "null"}\` -> \`${feed[FIELD_MAP.longTasksVersion]}\`.`, "");
}
writeFileSync(REPORT_PATH, body.join("\n") + "\n");

setOutput("status", "changes");
setOutput("title", title);
console.log(title);
