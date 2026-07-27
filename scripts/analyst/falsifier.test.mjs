// Designed with Claude (Anthropic)
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveFalsifier, resolveOutstanding, readPanelField } from "./falsifier.mjs";

const PANELS = [
  {
    panel: "exposed_vs_control_jobs",
    differential_exposed_minus_control: -2.5,
    control_value: 1.3,
    deviation_from_normal: { against_fixed_pre2020_baseline: 0.26 },
  },
  {
    panel: "worker_share_of_income",
    change_over_4_quarters: -1.0,
  },
];

const base = {
  panel: "exposed_vs_control_jobs",
  field: "differential_exposed_minus_control",
  comparator: "at_or_below",
  value: -3.2,
  by: "2026-10-25",
  scorable: true,
};

test("a condition not met before the horizon is NOT_YET_DUE", () => {
  const r = resolveFalsifier(base, PANELS, "2026-08-01");
  assert.equal(r.outcome, "NOT_YET_DUE");
});

test("a condition not met after the horizon is NOT_FIRED, with the distance kept", () => {
  const r = resolveFalsifier(base, PANELS, "2026-11-01");
  assert.equal(r.outcome, "NOT_FIRED");
  // -3.2 threshold, -2.5 observed: 0.7 short. Kept so "nowhere near" and "just
  // missed" do not collapse into the same word.
  assert.equal(r.conditions[0].distanceToThreshold, -0.7);
  assert.match(r.weight, /Weak evidence/);
});

test("a met condition FIRES even before the horizon", () => {
  const moved = [{ ...PANELS[0], differential_exposed_minus_control: -4.0 }, PANELS[1]];
  const r = resolveFalsifier(base, moved, "2026-08-01");
  assert.equal(r.outcome, "FIRED");
  assert.match(r.reason, /ahead of the horizon/);
});

test("both conditions must hold, which is what buys the discrimination", () => {
  // The compound falsifier both analyst runs independently invented: the gap
  // widens AND control industries are still healthy. A general downturn takes
  // control down too, so the second condition is what stops a recession firing a
  // test meant to detect something AI-specific.
  const compound = {
    ...base,
    also: { panel: "exposed_vs_control_jobs", field: "control_value", comparator: "at_or_above", value: 1.0 },
  };
  const bothMet = [{ ...PANELS[0], differential_exposed_minus_control: -4.0, control_value: 1.3 }, PANELS[1]];
  assert.equal(resolveFalsifier(compound, bothMet, "2026-11-01").outcome, "FIRED");

  // Gap widened, but control collapsed too: an ordinary downturn, not displacement.
  const recession = [{ ...PANELS[0], differential_exposed_minus_control: -4.0, control_value: -0.8 }, PANELS[1]];
  const r = resolveFalsifier(compound, recession, "2026-11-01");
  assert.equal(r.outcome, "NOT_FIRED", "a recession must not fire an AI-specific falsifier");
  assert.equal(r.conditions[1].met, false);
});

test("a nested field is found one level deep", () => {
  const nested = readPanelField(PANELS, "exposed_vs_control_jobs", "against_fixed_pre2020_baseline");
  assert.equal(nested.ok, true);
  assert.equal(nested.value, 0.26);
  assert.equal(nested.via, "deviation_from_normal");
});

test("a missing panel or field is UNCHECKABLE with a stated reason, never NOT_FIRED", () => {
  // The distinction that matters: a broken instrument must not read as a correct
  // prediction. UNCHECKABLE and NOT_FIRED mean opposite things about our data.
  const gone = resolveFalsifier({ ...base, panel: "panel_that_was_removed" }, PANELS, "2026-11-01");
  assert.equal(gone.outcome, "UNCHECKABLE");
  assert.match(gone.reason, /not in the current payload/);

  const noField = resolveFalsifier({ ...base, field: "field_that_does_not_exist" }, PANELS, "2026-11-01");
  assert.equal(noField.outcome, "UNCHECKABLE");
});

test("an unscorable prose falsifier is UNCHECKABLE rather than quietly dropped", () => {
  // Every falsifier written before 2026-07-27 is this shape: free-text magnitude,
  // nothing to evaluate. They must appear in the record as unscorable rather than
  // vanishing, or the track record silently starts from a flattering baseline.
  const legacy = {
    panel: "exposed_vs_control_jobs",
    direction: "falls",
    magnitude: "at or below -3.5 percentage points (one standard deviation past its mean)",
    by: "2026-10-26",
    scorable: false,
    unscorableReason: "free-text magnitude",
  };
  const r = resolveFalsifier(legacy, PANELS, "2026-11-01");
  assert.equal(r.outcome, "UNCHECKABLE");
});

test("the tally refuses to claim a track record it does not have", () => {
  const runs = [
    { runAt: "2026-06-01", dataMonth: "2026-05", verdict: "AUGMENTATION", falsifier: base },
    { runAt: "2026-07-01", dataMonth: "2026-06", verdict: "AUGMENTATION", falsifier: base },
  ];
  const open = resolveOutstanding(runs, PANELS, "2026-08-01");
  assert.equal(open.tally.NOT_YET_DUE, 2);
  assert.match(open.summary, /no track record to report/);

  const settledRuns = resolveOutstanding(runs, PANELS, "2026-11-01");
  assert.equal(settledRuns.tally.NOT_FIRED, 2);
  assert.match(settledRuns.summary, /Too few settled predictions/);
});

test("a settled resolution is not re-litigated on a later run", () => {
  const runs = [{
    runAt: "2026-06-01", dataMonth: "2026-05", verdict: "AUGMENTATION", falsifier: base,
    falsifierResolution: { outcome: "FIRED", reason: "settled earlier" },
  }];
  const out = resolveOutstanding(runs, PANELS, "2026-11-01");
  assert.equal(out.resolutions[0].outcome, "FIRED");
  assert.equal(out.tally.FIRED, 1);
});
