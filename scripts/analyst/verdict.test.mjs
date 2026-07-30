// Designed with Claude (Anthropic)
// Tests for the Analyst verdict derivation. Run: `node --test scripts/analyst/`
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveVerdict, chainState } from "./verdict.mjs";

const base = {
  laborVoteStates: ["steady", "steady", "steady"],
  recessionVeto: false,
  capabilityOpen: true,
  adoptionRising: true,
  productivityYoY: 2.8, // in the [2.7, 3.4) band
  aei: { augmentPct: 57, automatePct: 43 }, // augmentation leads
  dataIntegrity: { ok: true, reason: null },
};

test("quiet + gains visible -> AUGMENTATION_HOLDING", () => {
  const r = deriveVerdict(base);
  assert.equal(r.verdict, "AUGMENTATION_HOLDING");
  assert.equal(r.mechanicalState, "STEADY");
  assert.equal(r.gainsVisible, true);
});

test("quiet but productivity below band -> MIXED (not augmentation)", () => {
  const r = deriveVerdict({ ...base, productivityYoY: 2.0 });
  assert.equal(r.verdict, "MIXED_TRANSITIONING");
  assert.equal(r.gainsVisible, false);
});

test("quiet but AEI automation-leaning -> MIXED (not augmentation)", () => {
  const r = deriveVerdict({ ...base, aei: { augmentPct: 40, automatePct: 60 } });
  assert.equal(r.verdict, "MIXED_TRANSITIONING");
});

test("one differential firing -> MIXED_TRANSITIONING", () => {
  const r = deriveVerdict({ ...base, laborVoteStates: ["break", "steady", "steady"] });
  assert.equal(r.verdict, "MIXED_TRANSITIONING");
  assert.equal(r.mechanicalState, "WATCH");
  assert.equal(r.breadth, 1);
});

test("full cluster (breadth>=2, gates open, no veto) -> DISPLACEMENT_EMERGING", () => {
  const r = deriveVerdict({ ...base, laborVoteStates: ["break", "watch", "steady"] });
  assert.equal(r.verdict, "DISPLACEMENT_EMERGING");
  assert.equal(r.mechanicalState, "BREAK");
});

test("flat adoption no longer holds a break down", () => {
  // THE ADOPTION GATE IS REMOVED (2026-07-29). It used to force WATCH on this input.
  //
  // Two reasons. It could not fail: about a fifth of firms now report using AI, so the
  // gate was permanently open and only a broken survey could have shut it, which makes
  // it decoration implying a check nobody performs. And it was the wrong shape for the
  // timing — adoption is a lagging, quarterly, self-reported survey of whether firms
  // use AI at all, while displacement appears as soon as capability covers the work
  // today's adopters already do. Gating a fast monthly signal behind a slow annual one
  // delays exactly the warning this exists to give.
  const flat = deriveVerdict({ ...base, laborVoteStates: ["break", "watch", "steady"], adoptionRising: false });
  const rising = deriveVerdict({ ...base, laborVoteStates: ["break", "watch", "steady"], adoptionRising: true });
  assert.equal(flat.mechanicalState, "BREAK", "flat adoption must no longer hold a break down");
  assert.equal(flat.verdict, "DISPLACEMENT_EMERGING");
  assert.equal(flat.mechanicalState, rising.mechanicalState, "adoption must change nothing");
  // Still recorded, so the log shows what deployment was doing at the time.
  assert.equal(flat.factors.adoptionRising, false);
});

test("an inverted curve no longer downgrades a firing verdict", () => {
  // THE VETO IS REMOVED (2026-07-29). It used to turn this exact input into
  // CONFOUNDED via a recession_veto pathway. Two reasons it had to go, and the
  // second is the one that decided it.
  //
  // It contradicted a rule the analyst is given in the same payload: the curve
  // prices expected conditions, not realised ones, so it cannot exculpate weakness
  // already in the data. And it assumed the recession must be the confounder — but
  // if AI-driven labour weakness is part of what tips the economy into one, the
  // curve is downstream of the thing being measured and the veto suppresses the
  // signal exactly when it is real.
  const firing = { ...base, laborVoteStates: ["break", "watch", "steady"] };
  const withInversion = deriveVerdict({ ...firing, recessionVeto: true });
  const without = deriveVerdict({ ...firing, recessionVeto: false });

  assert.notEqual(withInversion.verdict, "CONFOUNDED");
  assert.equal(withInversion.confoundedPathway, null);
  // The curve now changes NOTHING about the verdict, which is the actual claim.
  assert.equal(withInversion.verdict, without.verdict);
  assert.equal(withInversion.mechanicalState, without.mechanicalState);
});

test("the curve is still recorded, so the run log keeps what it said", () => {
  // Removed as a DECIDER, not as an observation. The macro reading stays computed,
  // stays on the dashboard and stays in the analyst's payload; dropping it from the
  // record would lose the ability to check later whether the veto would have been
  // right, which is the evidence anyone would need to argue for putting it back.
  const r = deriveVerdict({ ...base, recessionVeto: true });
  assert.equal(r.factors.recessionVeto, true);
});

test("data-integrity failure -> CONFOUNDED (data_integrity), overrides everything", () => {
  const r = deriveVerdict({
    ...base,
    laborVoteStates: ["break", "watch", "steady"],
    dataIntegrity: { ok: false, reason: "September release shifted; only partial cycle collected" },
  });
  assert.equal(r.verdict, "CONFOUNDED");
  assert.equal(r.confoundedPathway, "data_integrity");
  assert.match(r.namedConfounder, /shifted/);
});

test("chainState breadth counts non-steady votes only", () => {
  assert.equal(chainState({ laborVoteStates: ["watch", "break", "steady"], capabilityOpen: true }).breadth, 2);
});

test("the early-warning line forces amber on its own, and matches the app", () => {
  // Added to this file 2026-07-29; the app has had it longer. Without it the two
  // repositories disagreed at breadth zero with the line crossed — the Dashboard tab
  // would have shown amber while the Analyst tab showed green, and the line IS crossed
  // today at -1.3%.
  //
  // Deliberately an ABSOLUTE level, not a deviation: a z-score can sit inside its band
  // while employment falls outright, because the band is built from the series' own
  // history. This asks the plainer question.
  const quiet = { ...base, laborVoteStates: ["steady", "steady", "steady"] };

  // Nothing firing and employment growing: green.
  const green = deriveVerdict({ ...quiet, exposedJobGrowthPct: 1.2 });
  assert.equal(green.mechanicalState, "STEADY");
  assert.equal(green.earlyWarning, false);

  // Nothing firing but exposed employment falling past the line: amber on its own.
  const amber = deriveVerdict({ ...quiet, exposedJobGrowthPct: -1.3 });
  assert.equal(amber.mechanicalState, "WATCH");
  assert.equal(amber.earlyWarning, true);
  assert.equal(amber.breadth, 0, "it must fire without any differential firing");

  // Exactly on the line counts, matching every other inclusive threshold here.
  assert.equal(deriveVerdict({ ...quiet, exposedJobGrowthPct: -1.0 }).earlyWarning, true);
  assert.equal(deriveVerdict({ ...quiet, exposedJobGrowthPct: -0.9 }).earlyWarning, false);

  // ABSENT IS NOT ZERO AND NOT SAFE-LOOKING. A missing figure must not silently read
  // as healthy growth, so it leaves the line unfired rather than asserting anything.
  const missing = deriveVerdict({ ...quiet, exposedJobGrowthPct: null });
  assert.equal(missing.earlyWarning, false);
  assert.equal(missing.mechanicalState, "STEADY");

  // And it cannot promote a break: it is a floor on amber, never a route to red.
  const bothFiring = deriveVerdict({
    ...base, laborVoteStates: ["break", "watch", "steady"], exposedJobGrowthPct: -5.0,
  });
  assert.equal(bothFiring.mechanicalState, "BREAK", "breadth still decides red");
});
