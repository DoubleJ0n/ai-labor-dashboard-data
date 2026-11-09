// Designed with Claude (Anthropic)
// scorecard: publishes the falsifier record the analyst already keeps, in a shape the
// app can draw.
//
// WHY THIS EXISTS. Every run pre-registers what would overturn it, and every later run
// scores those predictions: FIRED, NOT_FIRED, NOT_YET_DUE, UNCHECKABLE. That record has
// lived in data/analyst/runs.json since the first run and NOWHERE ELSE. The dissent log
// the app reads carries the falsifier as text and never its outcome, so the one
// accountability mechanism the README promises existed, worked, and was invisible to
// its only reader. By 2026-11 the record stood at 8 fired and 4 not fired, with six of
// eight displacement calls overturned by their own falsifier, and the app showed none
// of it.
//
// Under a FORCED BINARY call the record is the whole point. The analyst must pick a
// side on indecisive data, so oscillation and low confidence are the expected output,
// and the information is entirely in which calls survived. A bet nobody can lose says
// nothing; this is where the bets are settled.
//
// DERIVED, NOT NEW. Nothing here is computed from panel data. runs.json is read, the
// resolutions it holds are copied out, and a tally and a streak are counted. The
// dissent log is not touched: it stays append-only and this file is regenerated whole.
// Runs from the analysis-refresh workflow after the analyst step, and stands alone:
//
//   node scripts/analyst/scorecard.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUNS_PATH = path.join(repoRoot, "data", "analyst", "runs.json");
const OUT_PATH = path.join(repoRoot, "data", "analyst", "scorecard.json");

export const OUTCOMES = ["FIRED", "NOT_FIRED", "NOT_YET_DUE", "UNCHECKABLE"];

/** The scorecard for a runs.json array (oldest first). Pure; tested. */
export function buildScorecard(runs, nowIso = new Date().toISOString()) {
  const sorted = [...runs].sort((a, b) => String(a.runAt).localeCompare(String(b.runAt)));
  const entries = sorted.map((r) => {
    const res = r.falsifierResolution ?? { outcome: "NOT_YET_DUE", reason: "not yet scored" };
    const outcome = OUTCOMES.includes(res.outcome) ? res.outcome : "UNCHECKABLE";
    const primary = Array.isArray(res.conditions) ? res.conditions.find((c) => c.role === "primary") ?? res.conditions[0] : null;
    return {
      runAt: r.runAt,
      dataMonth: r.dataMonth ?? null,
      verdict: r.verdict ?? null,
      confidence: r.passes?.pass1?.confidence ?? null,
      outcome,
      reason: res.reason ?? null,
      by: r.falsifier?.by ?? null,
      horizonDays: r.falsifierHorizonDays ?? null,
      // Signed distance of the primary condition to its threshold at scoring time, in
      // the condition's own units. Lets NOT_FIRED read as "nowhere near" or "just
      // missed" rather than one word.
      distanceToThreshold: primary?.distanceToThreshold ?? null,
      observed: primary?.observed ?? null,
      threshold: primary?.threshold ?? null,
      falsifierPlain: r.falsifierPlain ?? null,
      flippedFromPriorRun: r.flippedFromPriorRun ?? null,
    };
  });

  const tally = { FIRED: 0, NOT_FIRED: 0, NOT_YET_DUE: 0, UNCHECKABLE: 0 };
  const byVerdict = {};
  for (const e of entries) {
    tally[e.outcome]++;
    if (e.verdict) {
      byVerdict[e.verdict] ??= { FIRED: 0, NOT_FIRED: 0, NOT_YET_DUE: 0, UNCHECKABLE: 0, runs: 0 };
      byVerdict[e.verdict][e.outcome]++;
      byVerdict[e.verdict].runs++;
    }
  }

  // The streak: how many consecutive runs, ending at the newest, share its verdict.
  let streak = 0;
  let streakSince = null;
  const latestVerdict = entries.at(-1)?.verdict ?? null;
  for (let i = entries.length - 1; i >= 0 && entries[i].verdict === latestVerdict; i--) {
    streak++;
    streakSince = entries[i].runAt;
  }
  // And in DATA MONTHS, which is the unit a reader thinks in: the analyst re-reads a
  // month several times, so a run count overstates a streak.
  const streakMonths = new Set(entries.slice(entries.length - streak).map((e) => e.dataMonth).filter(Boolean)).size;

  const flips = entries.filter((e) => e.flippedFromPriorRun === true).length;
  const settled = tally.FIRED + tally.NOT_FIRED;

  return {
    schemaVersion: 1,
    description:
      "Each analyst run pre-registers a condition that would overturn it within its horizon; later runs score it. " +
      "FIRED means the data did what the analyst said would prove it wrong. NOT_FIRED means the horizon passed and it did not, " +
      "which is weak evidence for the reading, since most falsifiers sit at levels rarely reached. Derived from runs.json; the dissent log is untouched.",
    lastRefreshed: nowIso.replace(/\.\d{3}Z$/, "Z"),
    runs: entries.length,
    tally,
    settled,
    firedSharePct: settled === 0 ? null : Math.round((tally.FIRED / settled) * 1000) / 10,
    byVerdict,
    streak: { verdict: latestVerdict, runs: streak, dataMonths: streakMonths, since: streakSince },
    flips,
    entries,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const log = JSON.parse(readFileSync(RUNS_PATH, "utf8"));
  const runs = Array.isArray(log) ? log : log.runs ?? [];
  if (runs.length === 0) {
    console.error("scorecard: runs.json holds no runs");
    process.exit(1);
  }
  const card = buildScorecard(runs);
  let prior = null;
  try { prior = JSON.parse(readFileSync(OUT_PATH, "utf8")); } catch { /* first run */ }
  const strip = (c) => c && JSON.stringify({ ...c, lastRefreshed: null });
  if (prior && strip(prior) === strip(card)) {
    console.log(`scorecard: no change (${card.runs} runs, ${card.tally.FIRED} fired / ${card.tally.NOT_FIRED} not fired / ${card.tally.NOT_YET_DUE} pending)`);
    process.exit(0);
  }
  writeFileSync(OUT_PATH, JSON.stringify(card, null, 2) + "\n", "utf8");
  console.log(
    `scorecard: ${card.runs} runs; ${card.tally.FIRED} fired, ${card.tally.NOT_FIRED} not fired, ` +
    `${card.tally.NOT_YET_DUE} pending, ${card.tally.UNCHECKABLE} uncheckable; ` +
    `streak ${card.streak.verdict} x${card.streak.runs} runs (${card.streak.dataMonths} data months)`,
  );
}
