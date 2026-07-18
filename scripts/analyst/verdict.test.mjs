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

test("no adoption gate -> cannot reach BREAK, verdict MIXED", () => {
  const r = deriveVerdict({ ...base, laborVoteStates: ["break", "watch", "steady"], adoptionRising: false });
  assert.equal(r.mechanicalState, "WATCH");
  assert.equal(r.verdict, "MIXED_TRANSITIONING");
});

test("recession veto while labor fires -> CONFOUNDED (recession_veto)", () => {
  const r = deriveVerdict({ ...base, laborVoteStates: ["break", "watch", "steady"], recessionVeto: true });
  assert.equal(r.verdict, "CONFOUNDED");
  assert.equal(r.confoundedPathway, "recession_veto");
  assert.ok(r.namedConfounder && r.namedConfounder.length > 0);
});

test("recession veto but NO labor firing -> not confounded", () => {
  const r = deriveVerdict({ ...base, recessionVeto: true });
  assert.notEqual(r.verdict, "CONFOUNDED");
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
  assert.equal(chainState({ laborVoteStates: ["watch", "break", "steady"], recessionVeto: false, capabilityOpen: true, adoptionRising: true }).breadth, 2);
});
