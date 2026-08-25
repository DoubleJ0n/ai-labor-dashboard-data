// Designed with Claude (Anthropic)
//
// gdpval-refresh: pulls the GDPval-AA leaderboard published by Artificial
// Analysis — their Elo evaluation built on OpenAI's GDPval dataset (44
// occupations, 9 industries). Models get shell access and web browsing in an
// agentic loop; outputs are compared blind, head to head, and the pairwise
// results are aggregated into an Elo per model.
//
// WHY SCRAPE: the Artificial Analysis Data API exposes gdpval_aa_elo, but only
// on a paid tier behind an org-scoped key. The public leaderboard page ships the
// same numbers in its Next.js flight payload, so this job reads them from there.
// That is a fragile path by construction, so every structural assumption below
// FAILS LOUD rather than guessing — and the job opens a PR instead of
// committing, so a human sees every change (same gate as METR and adoption).
//
// POOL VERSIONS ARE NOT COMPARABLE. Elo is frozen per index version: v1 was
// topped by Opus 4.8 at 1890, v2 by Opus 5 at 1861, and a level in one pool
// means nothing against a level in the other. The upstream field name carries
// the version (`gdpval_v2`), so this job reads the version out of the data
// itself and fails when it changes — a pool roll is a re-registration, not
// maintenance. Every record is stored WITH its pool version so the app can
// refuse a cross-version matchup.
//
// This job rewrites ONLY the `leaderboard` section of the snapshot. The
// `expertWinRate` section (OpenAI's own published GDPval win-rate figures, a
// hand-pinned table with its own provenance) is never touched here.
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  GDPVAL_POOL_VERSION, GDPVAL_MIN_RECORDS, GDPVAL_REQUIRED_LABS,
  GDPVAL_MAX_ELO, GDPVAL_MIN_TOP_ELO, GDPVAL_MIN_ELO_SPREAD,
} from "./config.mjs";

// RESTRUCTURED 2026-08-24. Upstream migrated the payload to camelCase and stopped
// emitting full benchmark records for all but the ~30 models it features. That looked
// terminal — the Elo for the other 180 was simply not in the JSON any more, and the
// obvious readings were "pay for the Data API" or "lose the panel".
//
// Both were wrong. The leaderboard <table> is still server-rendered in full, 213 rows,
// more than the 192 this job used to publish. The data never left the page; it moved
// out of the JSON and into the markup. So this job now parses the table for Elo and
// keeps the JSON only for the slug and exact release date it joins on.
//
// Do not "simplify" that split back to one source. The table has no slugs and dates
// only to the month; the JSON has both but covers 30 models. Each covers the other.
const PAGE_URL = "https://artificialanalysis.ai/evaluations/gdpval-aa";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SNAPSHOT_PATH = path.join(repoRoot, "data", "gdpval", "leaderboard.json");
const REPORT_PATH = path.join(repoRoot, "gdpval-refresh-report.md");

function fail(msg) {
  console.error(`gdpval-refresh FATAL: ${msg}`);
  process.exit(1);
}
function setOutput(key, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}<<EOF\n${value}\nEOF\n`);
}

const html = await fetch(PAGE_URL, {
  headers: { "user-agent": "ai-labor-dashboard-data/1.0 (+https://github.com/DoubleJ0n/ai-labor-dashboard-data)" },
})
  .then((r) => (r.ok ? r.text() : fail(`page HTTP ${r.status}`)))
  .catch((e) => fail(`page fetch threw: ${e.message ?? e}`));

if (html.length < 500_000) {
  // The real page is multi-megabyte. A short body means a block page, a soft
  // 404, or a client-rendered shell — content check, not status check.
  fail(`page body only ${html.length} bytes — blocked, or no longer server-rendered`);
}

// The payload arrives as JSON escaped inside JS string literals, split across
// many self.__next_f.push() chunks. Unescape, then stitch the chunk seams shut
// so a record is never cut in half by one.
const flat = html
  .replace(/\\"/g, '"')
  .replace(/"\]\)<\/script><script>self\.__next_f\.push\(\[1,"/g, "");

// --- Pool version, read out of the data ---------------------------------------
// On 2026-08-16 upstream migrated the payload to camelCase and dropped the version
// out of the Elo field entirely: "gdpval_v2":1861 became "gdpval":1844.67. The version
// is therefore no longer in the DATA, only in the page identity — the dataset title
// ("GDPval-AA v2 Leaderboard") and the canonical slug ("gdpval-aa-v2").
//
// This is strictly weaker than what it replaces. The old field name made a pool roll
// impossible to miss; a title is prose and prose gets reworded. Both anchors are
// required to agree, so a silent roll has to defeat two independent strings at once.
// If upstream ever drops the version from the page as well, this MUST fail rather
// than assume: publishing v3 numbers under a v2 label is the one unrecoverable error
// here, because Elo levels are meaningless across pools.
const versions = [...new Set([
  ...[...flat.matchAll(/gdpval-aa-v(\d+)/gi)].map((m) => `v${m[1]}`),
  ...[...flat.matchAll(/GDPval-AA v(\d+)/g)].map((m) => `v${m[1]}`),
])];
if (versions.length === 0) {
  fail(
    'no pool version found on the page — upstream dropped the version from both the ' +
      'slug and the dataset title. Elo is frozen per pool, so publishing without a ' +
      'confirmed version is not safe. A human must establish which pool this is.',
  );
}
if (versions.length > 1) {
  fail(`page carries multiple pool versions [${versions.join(", ")}] — pools are not comparable; a human must decide which to register`);
}
const poolVersion = versions[0];
if (poolVersion !== GDPVAL_POOL_VERSION) {
  fail(
    `pool rolled: page publishes ${poolVersion}, config registers ${GDPVAL_POOL_VERSION}. ` +
      `Elo is frozen per pool and versions are not comparable — re-register GDPVAL_POOL_VERSION ` +
      `and decide what happens to the stored ${GDPVAL_POOL_VERSION} records before this job runs again.`,
  );
}

// --- slug -> display name + lab, from the model-picker array ------------------
const nameBySlug = new Map();
const labBySlug = new Map();
// ANCHOR ON THE KEYS THAT MATTER, NOT ON FIELD ADJACENCY. This regex used to require
// "isReasoning" to sit immediately before "creator". On 2026-08-16 upstream inserted a
// "releaseDate" field between them and every record stopped matching at once — the job
// went red daily reporting a restructured payload, when in fact the three fields this
// parser actually reads (slug, name, creator.name) were all still there, unchanged and
// in the same order.
//
// A schema that grows a field is the ordinary case, not a break, and it should not cost
// a red run: the halt for a genuine restructure is the `nameBySlug.size === 0` check
// below, which still fires if slug/name/creator really do move or vanish. So the
// middle of the record is now "any number of simple scalar fields", which absorbs the
// next added field too.
// UPDATE 2026-08-24: the previous pattern allowed "any number of simple scalar
// fields" between isReasoning and creator. Upstream then added NESTED ones —
// "effort":{...} and "release":{...} — and every record stopped matching again, the
// same failure the earlier fix was written to prevent, one level down. Enumerating
// what may sit in the middle is the losing move: each new shape is another outage.
// So anchor only on the three fields actually read, and scan a bounded window for
// creator rather than describing what separates them.
// "deprecated" is what separates a real model record from a NESTED one. Each record
// also contains "release":{"slug":...,"name":...}, which matches a bare slug/name
// pattern and, being later in the record, silently overwrote the real entry with the
// release's short name — "Claude Opus 5" clobbering "Claude Opus 5 (Adaptive
// Reasoning, Max Effort)". That cost 57 of 213 joins and made models appear as both
// new and dropped in the same report. Anchor on a field the nested object lacks.
for (const m of flat.matchAll(/\{"slug":"([^"]+)","name":"([^"]+)","deprecated":/g)) {
  const window = flat.slice(m.index, m.index + 1200);
  const creator = /"creator":\{"id":"[^"]+","name":"([^"]+)"/.exec(window);
  if (!creator) continue;
  // Do not let a window run past its own record into the next one.
  const nextRecord = window.search(/\},\{"slug":"/);
  if (nextRecord !== -1 && creator.index > nextRecord) continue;
  nameBySlug.set(m[1], m[2]);
  labBySlug.set(m[1], creator[1]);
}
if (nameBySlug.size === 0) fail("model-picker array not found — upstream restructured the payload");

// --- Elo, from the SERVER-RENDERED LEADERBOARD TABLE -------------------------
// CHANGED 2026-08-24. This used to read the JSON flight payload, which carried a full
// benchmark record per model. Upstream now emits those for only the ~30 models it
// features; the other 180 are absent from the JSON entirely, which is what turned this
// job red and what made the JSON path look like a dead end.
//
// It is not one. The leaderboard <table> is still server-rendered in full — 213 rows,
// MORE than the 192 this job used to publish. So the data never left the page, it moved
// out of the JSON and into the markup, and the fix is to read the markup.
//
// COST OF THE MOVE, stated plainly because it is a real fidelity loss:
//   - Elo is rendered to whole numbers. The JSON carried two decimals. Stored values
//     are integers from here on, and a resumed history will show a seam.
//   - The table gives release month ("Jul 2026"), not a date. Exact dates are recovered
//     by joining to the model picker on name, which still carries them; rows that do
//     not join keep month precision as "YYYY-MM".
// Neither affects how the app uses this: Elo differences of ~1 are noise against
// confidence intervals of +/-20, and the panel plots ordering, not deltas.
const nameToSlug = new Map([...nameBySlug].map(([slug, name]) => [name, slug]));
const dateByName = new Map();
for (const m of flat.matchAll(/\{"slug":"([^"]+)","name":"([^"]+)","deprecated":/g)) {
  const w = flat.slice(m.index, m.index + 1200);
  const d = /"releaseDate":"(\d{4}-\d{2}-\d{2})"/.exec(w);
  if (d) dateByName.set(m[2], d[1]);
}

const decode = (t) =>
  t.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
   .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, " ").trim();

const MONTHS = { Jan:"01",Feb:"02",Mar:"03",Apr:"04",May:"05",Jun:"06",
                 Jul:"07",Aug:"08",Sep:"09",Oct:"10",Nov:"11",Dec:"12" };

const rowHtml = html.split(/<tr[\s>]/).slice(1);
const hits = [];
for (const row of rowHtml) {
  const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)]
    .map((m) => decode(m[1].replace(/<[^>]+>/g, "")));
  if (cells.length < 5) continue; // header row, or a layout row
  const [rank, lab, model, eloRaw, , dateRaw] = cells;
  if (!/^\d+$/.test(rank)) continue;
  // U+2212 MINUS SIGN, not a hyphen: the tail of this board goes negative.
  const elo = parseFloat(eloRaw.replace(/−/g, "-").replace(/,/g, ""));
  if (!Number.isFinite(elo)) continue;
  hits.push({ rank: +rank, lab, model, elo, dateRaw });
}

const records = [];
for (const h of hits) {
  const mon = /^([A-Za-z]{3})\s+(\d{4})$/.exec(h.dateRaw || "");
  const releaseDate =
    dateByName.get(h.model) ?? (mon ? `${mon[2]}-${MONTHS[mon[1]] ?? "01"}` : null);
  if (!releaseDate || !h.lab) continue;
  // Rows the picker does not cover still need a stable unique key, or several
  // nulls collide and trip the duplicate-slug guard. A slug derived from the
  // display name is stable across runs, which is all the key is for.
  const slug = nameToSlug.get(h.model)
    ?? h.model.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  records.push({
    slug,
    model: h.model,
    lab: h.lab,
    releaseDate,
    elo: Math.round(h.elo * 100) / 100,
    poolVersion,
  });
}

// --- INVARIANTS — fail loud, never publish a half-parsed leaderboard ---------
if (records.length !== hits.length) {
  fail(`parsed ${records.length} of ${hits.length} Elo records — record layout changed`);
}
if (records.length < GDPVAL_MIN_RECORDS) {
  fail(`only ${records.length} records parsed, expected at least ${GDPVAL_MIN_RECORDS}`);
}
const unlabelled = records.filter((r) => !r.lab);
if (unlabelled.length) {
  fail(`${unlabelled.length} records have no lab (e.g. ${unlabelled[0].slug}) — creator join broke`);
}
// See GDPVAL_MAX_ELO in config.mjs for why there is no per-value floor here.
const unusable = records.filter((r) => !Number.isFinite(r.elo) || r.elo > GDPVAL_MAX_ELO);
if (unusable.length) {
  fail(`${unusable.length} Elo values are not finite or exceed ${GDPVAL_MAX_ELO} (e.g. ${unusable[0].slug} ${unusable[0].elo})`);
}
const elos = records.map((r) => r.elo);
const topElo = Math.max(...elos);
const eloSpread = topElo - Math.min(...elos);
if (topElo < GDPVAL_MIN_TOP_ELO) {
  fail(`top Elo is only ${topElo}, below ${GDPVAL_MIN_TOP_ELO} — this looks like a percentage or rank column, not Elo`);
}
if (eloSpread < GDPVAL_MIN_ELO_SPREAD) {
  fail(`Elo spread is only ${Math.round(eloSpread)}, below ${GDPVAL_MIN_ELO_SPREAD} — the parsed column does not vary like Elo`);
}
const labs = new Set(records.map((r) => r.lab));
const missingLabs = GDPVAL_REQUIRED_LABS.filter((l) => !labs.has(l));
if (missingLabs.length) {
  fail(`required labs absent from the leaderboard: [${missingLabs.join(", ")}] — the per-lab chart cannot be built`);
}
if (new Set(records.map((r) => r.slug)).size !== records.length) {
  fail("duplicate slugs — the same model was parsed twice");
}

records.sort((a, b) => b.elo - a.elo || a.slug.localeCompare(b.slug));

// --- Write, only on change ---------------------------------------------------
mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
let snapshot;
try {
  snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
} catch {
  snapshot = { schemaVersion: 1 };
}

const leaderboard = {
  poolVersion,
  source: "Artificial Analysis - GDPval-AA leaderboard (Elo on OpenAI's GDPval dataset)",
  sourceUrl: PAGE_URL,
  note:
    "Elo from blind pairwise comparisons of model outputs on GDPval knowledge-work tasks. " +
    "Levels carry no information in isolation - only differences do - and the comparison pool " +
    "contains no human, so the scale has no absolute anchor. Elo is frozen per pool version; " +
    "records from different pool versions must never be compared. Entries are per effort setting: " +
    "the same model at two reasoning efforts is two records with two Elos.",
  records,
  lastRefreshed: new Date().toISOString().slice(0, 10),
};

const prior = snapshot.leaderboard?.records ?? [];
if (JSON.stringify(records) === JSON.stringify(prior) && snapshot.leaderboard?.poolVersion === poolVersion) {
  console.log(`gdpval: no change (${records.length} records, pool ${poolVersion})`);
  setOutput("status", "nochange");
  process.exit(0);
}
snapshot.leaderboard = leaderboard;
writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2) + "\n", "utf8");

// --- Human-readable diff for the PR body -------------------------------------
const priorBySlug = new Map(prior.map((r) => [r.slug, r]));
const added = records.filter((r) => !priorBySlug.has(r.slug));
const moved = records.filter((r) => priorBySlug.has(r.slug) && priorBySlug.get(r.slug).elo !== r.elo);
const dropped = prior.filter((r) => !records.some((n) => n.slug === r.slug));
const top = records[0];
const bestFor = (lab) => records.find((r) => r.lab === lab);

const lines = [
  `GDPval-AA leaderboard, pool ${poolVersion}: ${records.length} records.`,
  "",
  `Top: **${top.model}** (${top.lab}) ${top.elo}.`,
  ...GDPVAL_REQUIRED_LABS.map((l) => {
    const r = bestFor(l);
    return `Leading ${l}: ${r.model} ${r.elo} (released ${r.releaseDate}).`;
  }),
  "",
  `New models: ${added.length ? added.map((r) => `${r.model} ${r.elo}`).join(", ") : "none"}`,
  `Elo revisions: ${moved.length
    ? moved.map((r) => `${r.model} ${priorBySlug.get(r.slug).elo} -> ${r.elo}`).join(", ")
    : "none"}`,
  `Dropped: ${dropped.length ? dropped.map((r) => r.model).join(", ") : "none"}`,
  "",
  "Scraped from the leaderboard page's server-rendered payload (the Elo field is",
  "paywalled in the Data API). Every structural assumption fails loud, so a green",
  "run means the page still looks the way this job expects. Check the numbers above",
  "against the page before merging.",
  "",
  `Source: ${PAGE_URL}`,
];
writeFileSync(REPORT_PATH, lines.join("\n") + "\n", "utf8");

setOutput("status", "changes");
setOutput(
  "title",
  added.length
    ? `gdpval: ${added.length} new model${added.length === 1 ? "" : "s"} on the GDPval-AA board`
    : `gdpval: Elo revisions on the GDPval-AA board`,
);
console.log(lines.join("\n"));
