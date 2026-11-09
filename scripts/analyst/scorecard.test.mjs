// Designed with Claude (Anthropic)
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildScorecard, OUTCOMES } from "./scorecard.mjs";

const run = (runAt, dataMonth, verdict, outcome, extra = {}) => ({
  runAt, dataMonth, verdict,
  falsifier: { by: "2026-12-01" },
  falsifierHorizonDays: 90,
  falsifierResolution: outcome == null ? undefined : {
    outcome, reason: "test",
    conditions: [{ role: "primary", observed: 1.5, threshold: 2.0, distanceToThreshold: 0.5 }],
  },
  passes: { pass1: { confidence: "LOW" } },
  ...extra,
});

test("the tally counts every run once and the settled share ignores pending ones", () => {
  const card = buildScorecard([
    run("2026-08-01T00:00:00Z", "2026-06", "DISPLACEMENT", "FIRED"),
    run("2026-08-08T00:00:00Z", "2026-06", "DISPLACEMENT", "FIRED"),
    run("2026-09-01T00:00:00Z", "2026-07", "AUGMENTATION", "NOT_FIRED"),
    run("2026-10-01T00:00:00Z", "2026-08", "AUGMENTATION", "NOT_YET_DUE"),
    run("2026-11-01T00:00:00Z", "2026-09", "AUGMENTATION", null),
  ]);
  assert.deepEqual(card.tally, { FIRED: 2, NOT_FIRED: 1, NOT_YET_DUE: 2, UNCHECKABLE: 0 });
  assert.equal(card.settled, 3);
  assert.equal(card.firedSharePct, 66.7);
  assert.equal(card.byVerdict.DISPLACEMENT.FIRED, 2);
  assert.equal(card.byVerdict.AUGMENTATION.runs, 3);
});

test("the streak counts consecutive runs AND distinct data months ending at the newest", () => {
  const card = buildScorecard([
    run("2026-08-01T00:00:00Z", "2026-06", "DISPLACEMENT", "FIRED"),
    run("2026-09-01T00:00:00Z", "2026-07", "AUGMENTATION", "NOT_YET_DUE"),
    run("2026-09-08T00:00:00Z", "2026-07", "AUGMENTATION", "NOT_YET_DUE"),
    run("2026-10-01T00:00:00Z", "2026-08", "AUGMENTATION", "NOT_YET_DUE"),
  ]);
  assert.equal(card.streak.verdict, "AUGMENTATION");
  assert.equal(card.streak.runs, 3);
  assert.equal(card.streak.dataMonths, 2);
  assert.equal(card.streak.since, "2026-09-01T00:00:00Z");
});

test("runs are ordered by runAt whatever order the file holds them in", () => {
  const card = buildScorecard([
    run("2026-10-01T00:00:00Z", "2026-08", "AUGMENTATION", "NOT_YET_DUE"),
    run("2026-08-01T00:00:00Z", "2026-06", "DISPLACEMENT", "FIRED"),
  ]);
  assert.equal(card.entries[0].verdict, "DISPLACEMENT");
  assert.equal(card.entries[1].verdict, "AUGMENTATION");
});

test("an unknown outcome degrades to UNCHECKABLE rather than inventing a result", () => {
  const card = buildScorecard([run("2026-08-01T00:00:00Z", "2026-06", "DISPLACEMENT", "MAYBE")]);
  assert.equal(card.entries[0].outcome, "UNCHECKABLE");
  assert.ok(OUTCOMES.includes(card.entries[0].outcome));
});

test("the primary condition's distance is carried so NOT_FIRED can be read as near or far", () => {
  const card = buildScorecard([run("2026-08-01T00:00:00Z", "2026-06", "AUGMENTATION", "NOT_FIRED")]);
  assert.equal(card.entries[0].distanceToThreshold, 0.5);
  assert.equal(card.entries[0].observed, 1.5);
  assert.equal(card.entries[0].threshold, 2.0);
});
