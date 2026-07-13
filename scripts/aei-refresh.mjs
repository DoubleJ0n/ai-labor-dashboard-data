// Designed with Claude (Anthropic)
// aei-refresh: pulls the Anthropic Economic Index (how AI is actually used —
// augmentation vs automation) from its open Hugging Face dataset and updates
// the augment-vs-automate TREND. It enumerates the dataset's dated release
// folders via the HF API, so a NEW release is picked up automatically the next
// run and appended as a new trend point — no manual step.
//
// FREE (public dataset, no key, no model). Proposes changes as a PR (the user
// reviews each new release); a schema change (renamed/missing interaction
// categories) is flagged prominently in the PR rather than silently mis-computed.
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DATASET = "Anthropic/EconomicIndex";
const API = `https://huggingface.co/api/datasets/${DATASET}`;
const RAW = `https://huggingface.co/datasets/${DATASET}/resolve/main`;

// Anthropic's interaction taxonomy -> the two sides.
const AUTOMATION = ["directive", "feedback loop"];
const AUGMENTATION = ["task iteration", "learning", "validation"];
const EXPECTED = [...AUTOMATION, ...AUGMENTATION];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SNAPSHOT_PATH = path.join(repoRoot, "data", "aei", "augmentation.json");
const REPORT_PATH = path.join(repoRoot, "aei-refresh-report.md");

function fail(msg) { console.error(`aei-refresh FATAL: ${msg}`); process.exit(1); }
function setOutput(key, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}<<EOF\n${value}\nEOF\n`);
}

const meta = await fetch(API).then((r) => (r.ok ? r.json() : fail(`HF API HTTP ${r.status}`))).catch((e) => fail(`HF API threw: ${e.message ?? e}`));
const files = (meta.siblings ?? []).map((s) => s.rfilename);

// One augment/automate CSV per release folder (prefer the highest _vN, skip _by_task).
const byRelease = new Map();
for (const f of files) {
  const m = /^release_(\d{4})_(\d{2})_(\d{2})\/.*automation_vs_augmentation(?:_v(\d+))?\.csv$/.exec(f);
  if (!m || /_by_task/.test(f)) continue;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  const ver = m[4] ? Number(m[4]) : 0;
  const prev = byRelease.get(date);
  if (!prev || ver > prev.ver) byRelease.set(date, { path: f, ver });
}
if (byRelease.size === 0) fail("no automation_vs_augmentation release CSVs found (dataset restructured?)");

let schemaWarning = null;
const points = [];
for (const [date, { path: rel }] of [...byRelease.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const text = await fetch(`${RAW}/${rel}`).then((r) => (r.ok ? r.text() : null));
  if (!text) { schemaWarning = `could not fetch ${rel}`; continue; }
  const rows = {};
  text.split("\n").slice(1).forEach((line) => {
    const c = line.indexOf(",");
    if (c < 0) return;
    const key = line.slice(0, c).trim().toLowerCase();
    const v = parseFloat(line.slice(c + 1));
    if (key && Number.isFinite(v)) rows[key] = v;
  });
  // INVARIANT: the expected categories must be present.
  const missing = EXPECTED.filter((k) => !(k in rows));
  if (missing.length) { schemaWarning = `release ${date}: missing categories [${missing.join(", ")}]`; continue; }
  const auto = AUTOMATION.reduce((a, k) => a + rows[k], 0);
  const aug = AUGMENTATION.reduce((a, k) => a + rows[k], 0);
  const tot = auto + aug;
  if (tot <= 0) { schemaWarning = `release ${date}: zero total`; continue; }
  points.push({ date, augmentPct: Math.round((100 * aug / tot) * 10) / 10, automatePct: Math.round((100 * auto / tot) * 10) / 10 });
}
if (points.length < 1) fail(`no usable releases parsed${schemaWarning ? ` (${schemaWarning})` : ""}`);

const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
const before = JSON.stringify(snapshot.points ?? []);
snapshot.points = points;
snapshot.lastRefreshed = new Date().toISOString().slice(0, 10);

if (JSON.stringify(points) === before && !schemaWarning) {
  setOutput("status", "nochange");
  console.log("aei: no change");
  process.exit(0);
}
writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2) + "\n");

const latest = points[points.length - 1];
const title = schemaWarning
  ? `AEI SCHEMA CHANGE — review before merge (${points.length} releases parsed)`
  : `AEI: ${points.length} releases, latest ${latest.automatePct}% automation / ${latest.augmentPct}% augmentation (${latest.date})`;
writeFileSync(
  REPORT_PATH,
  [
    `# ${title}`,
    "",
    schemaWarning ? `⚠ **Schema warning:** ${schemaWarning}. The interaction categories may have been renamed upstream — confirm the automation/augmentation mapping before merging.` : "New Anthropic Economic Index data (augment vs automate).",
    "",
    "| release | augmentation % | automation % |",
    "|---|---|---|",
    ...points.map((p) => `| ${p.date} | ${p.augmentPct} | ${p.automatePct} |`),
    "",
    `Source: ${API}`,
  ].join("\n") + "\n",
);
setOutput("status", "changes");
setOutput("title", title);
console.log(title);
