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
// UPDATE 2026-10-16: upstream rolled v2 -> v2.1 and this parser could not represent a
// dotted version, so the two anchors disagreed BY CONSTRUCTION. `v(\d+)` stops at the
// first non-digit: the dataset title "GDPval-AA v2.1" read as "v2", while the slug,
// whose DOM id drops the separator ("gdpval-aa-v21-leaderboard"), read as "v21". Two
// spellings of ONE version looked like a page serving two pools, and the job failed
// every day for 23 days reporting "pools are not comparable" — which was never true of
// the page, only of the regex. A guard that cannot parse a minor bump does not protect
// the invariant, it just stops the feed and misattributes why.
//
// Each anchor is now parsed in its own spelling and compared on a normalised form. The
// title is authoritative for the canonical string because it is the only anchor that
// keeps the separator; the slug is checked against it with the dots removed. The
// agreement requirement is unchanged — a silent roll still has to defeat both strings —
// but it is now a comparison of like with like.
const titleVersions = [...new Set(
  [...flat.matchAll(/GDPval-AA v(\d+(?:\.\d+)*)/g)].map((m) => m[1]),
)];
const slugVersions = [...new Set(
  [...flat.matchAll(/gdpval-aa-v(\d+)/gi)].map((m) => m[1]),
)];
if (titleVersions.length === 0 && slugVersions.length === 0) {
  fail(
    'no pool version found on the page — upstream dropped the version from both the ' +
      'slug and the dataset title. Elo is frozen per pool, so publishing without a ' +
      'confirmed version is not safe. A human must establish which pool this is.',
  );
}
// A conflict WITHIN one anchor is a real conflict: one page claiming two pools.
if (titleVersions.length > 1) {
  fail(`dataset title carries multiple pool versions [${titleVersions.map((v) => `v${v}`).join(", ")}] — pools are not comparable; a human must decide which to register`);
}
if (slugVersions.length > 1) {
  fail(`page slugs carry multiple pool versions [${slugVersions.map((v) => `v${v}`).join(", ")}] — pools are not comparable; a human must decide which to register`);
}
// Dots removed, because that is the only difference the two spellings are allowed to
// have. Anything else is upstream disagreeing with itself and must not be guessed at.
if (titleVersions.length && slugVersions.length &&
    titleVersions[0].replace(/\./g, "") !== slugVersions[0]) {
  fail(
    `pool version anchors disagree: dataset title says v${titleVersions[0]}, slug says ` +
      `v${slugVersions[0]}. One of them has rolled without the other; a human must ` +
      `establish which pool this page is actually publishing.`,
  );
}
// Prefer the title: it is the only spelling that survives a minor bump intact. With the
// slug alone a multi-digit run cannot be re-separated — "21" is both v21 and v2.1 — and
// guessing there is exactly the silent miscategorisation this block exists to prevent.
if (!titleVersions.length && slugVersions[0].length > 1) {
  fail(
    `only the slug carries a pool version ("v${slugVersions[0]}") and the dataset title is ` +
      `gone, so the separator cannot be recovered — v${slugVersions[0]} and ` +
      `v${slugVersions[0].split("").join(".")} are indistinguishable here. A human must ` +
      `establish which pool this is.`,
  );
}
const poolVersion = `v${titleVersions[0] ?? slugVersions[0]}`;
if (poolVersion !== GDPVAL_POOL_VERSION) {
  fail(
    `pool rolled: page publishes ${poolVersion}, config registers ${GDPVAL_POOL_VERSION}. ` +
      `Elo is frozen per pool and versions are not comparable — re-register GDPVAL_POOL_VERSION ` +
      `and decide what happens to the stored ${GDPVAL_POOL_VERSION} records before this job runs again.`,
  );
}

// --- slug -> display name + lab + date, from the model-picker array -----------
// STOP REGEXING JSON. PARSE IT.
//
// This block has now broken three times in the same way, and each previous fix was a
// better guess about what sits between the fields it reads:
//   2026-08-16  "releaseDate" appeared between isReasoning and creator  -> no matches
//   2026-08-24  nested "effort"/"release" objects appeared               -> no matches
//   2026-10-16  "id" moved to the front and "shortName"/"suffix"/"release"
//               appeared between "name" and "deprecated"                -> no matches
// The 2026-08-24 note already named the losing move — "enumerating what may sit in the
// middle" — and then enumerated one more thing, the single field "deprecated" sitting
// immediately after "name". Upstream inserted three fields there and the anchor died
// again. Worse, that pattern still matches 510 compact records elsewhere in the payload
// that have no creator, so the window scan rejected every one and the count landed on
// exactly zero: the guard fired "upstream restructured the payload" when the gdpval-aa
// array was sitting there intact, with every field this parser wants.
//
// The array is JSON. It is valid JSON, it is delimited, and the page says which array
// it is ("slug":"gdpval-aa","initialModels":[...]). So find that array, match brackets
// to its end, and JSON.parse it. Field ORDER then stops mattering, added fields stop
// mattering, and nesting stops mattering — the three things that have broken this.
// What remains load-bearing is only the array's own name, and if upstream renames that
// the size check below still halts the run instead of publishing a half-join.
const pickerModels = (() => {
  const at = flat.search(/"slug":"gdpval-aa","initialModels":\s*\[/);
  if (at === -1) return [];
  const start = flat.indexOf("[", at);
  // String-aware bracket matching: a model name containing "]" must not end the array.
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < flat.length; i++) {
    const c = flat[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) {
      // A truncated or re-escaped payload must not read as "upstream restructured",
      // so say which of the two it is.
      try {
        return JSON.parse(flat.slice(start, i + 1));
      } catch (e) {
        fail(`found the gdpval-aa initialModels array but it did not parse as JSON (${e.message}) — the flight-chunk unescaping above is no longer producing valid JSON`);
      }
    }
  }
  fail("the gdpval-aa initialModels array is not bracket-balanced — the payload is truncated or chunk-stitching broke");
})();

const nameBySlug = new Map();
const labBySlug = new Map();
const dateByName = new Map();
for (const m of pickerModels) {
  // Read only the four fields this job actually uses, and skip a record that is
  // missing one rather than inventing a value for it.
  if (!m?.slug || !m?.name || !m?.creator?.name) continue;
  nameBySlug.set(m.slug, m.name);
  labBySlug.set(m.slug, m.creator.name);
  if (/^\d{4}-\d{2}-\d{2}$/.test(m.releaseDate ?? "")) dateByName.set(m.name, m.releaseDate);
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
// Keys this job has handed out, plus every key upstream owns. A derived slug must
// avoid both, and avoiding the full picker set keeps the result independent of row order.
const pickerSlugs = new Set(nameBySlug.keys());
const usedSlugs = new Set();
for (const h of hits) {
  const mon = /^([A-Za-z]{3})\s+(\d{4})$/.exec(h.dateRaw || "");
  const releaseDate =
    dateByName.get(h.model) ?? (mon ? `${mon[2]}-${MONTHS[mon[1]] ?? "01"}` : null);
  if (!releaseDate || !h.lab) continue;
  // Rows the picker does not cover still need a stable unique key, or several
  // nulls collide and trip the duplicate-slug guard. A slug derived from the
  // display name is stable across runs, which is all the key is for.
  //
  // UPDATE 2026-10-16: a derived slug can collide with a REAL one. The board carries
  // "Qwen3.8 Max (0902)", which joins the picker as "qwen3-8-max", and a separate older
  // "Qwen3.8 Max" row, which joins nothing and derives that same string — two different
  // models, two different Elos (1666 and 1604), one key. That tripped the duplicate-slug
  // guard, whose message ("the same model was parsed twice") described something that
  // was not happening and sent the reader looking for a parser bug.
  //
  // A derived slug is this job's own invention, not upstream's identifier, so it is the
  // one that must yield: it is checked against every picker slug — not just the ones
  // already emitted — so the outcome does not depend on which row is read first. The
  // release date disambiguates, and is as stable as the rest of the row.
  let slug = nameToSlug.get(h.model);
  if (!slug) {
    const base = h.model.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    slug = pickerSlugs.has(base) || usedSlugs.has(base) ? `${base}-${releaseDate}` : base;
  }
  if (usedSlugs.has(slug)) {
    // Two rows that are genuinely indistinguishable — the double parse the invariant
    // below is for, caught here where the row is still in hand to name it.
    fail(`two leaderboard rows are indistinguishable: "${h.model}" (${releaseDate}) resolves to the key "${slug}", which another row already holds`);
  }
  usedSlugs.add(slug);
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
