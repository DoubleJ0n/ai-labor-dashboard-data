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

test("a DOTTED path resolves, which the first live run needed", () => {
  // Regression. The first real run wrote `headline.change_over_12_months`, which is
  // the obvious thing to write when the payload nests, and the reader only handled
  // bare names — so the first structured falsifier scored UNCHECKABLE and the whole
  // point of making it machine-checkable was lost on run one.
  const nested = [{
    panel: "reabsorption",
    headline: { change_over_12_months: -0.5, fast_horizon: { change: -0.5 } },
  }];
  const one = readPanelField(nested, "reabsorption", "headline.change_over_12_months");
  assert.equal(one.ok, true);
  assert.equal(one.value, -0.5);

  // Two levels deep works too, so the format does not quietly cap at one.
  const two = readPanelField(nested, "reabsorption", "headline.fast_horizon.change");
  assert.equal(two.ok, true);
  assert.equal(two.value, -0.5);

  // A path that runs out says where, rather than reporting a bare not-found.
  const bad = readPanelField(nested, "reabsorption", "headline.nope.change");
  assert.equal(bad.ok, false);
  assert.match(bad.why, /runs out at "nope"/);

  // A path ending on an object rather than a number is refused, not coerced.
  const obj = readPanelField(nested, "reabsorption", "headline.fast_horizon");
  assert.equal(obj.ok, false);
  assert.match(obj.why, /does not end at a number/);
});

test("the actual first-run falsifier is scorable end to end", () => {
  // Verbatim from the live run, so this test fails if the shape it depends on moves.
  const live = {
    panel: "reabsorption",
    field: "headline.change_over_12_months",
    comparator: "at_or_above",
    value: -0.2,
    also: {
      panel: "exposed_vs_control_jobs",
      field: "differential_exposed_minus_control",
      comparator: "at_or_above",
      value: -1.75,
    },
    by: "2026-10-24",
    scorable: true,
  };
  const panels = [
    { panel: "reabsorption", headline: { change_over_12_months: -0.5 } },
    { panel: "exposed_vs_control_jobs", differential_exposed_minus_control: -2.5 },
  ];
  const open = resolveFalsifier(live, panels, "2026-08-01");
  assert.equal(open.outcome, "NOT_YET_DUE", "must be scorable, not UNCHECKABLE");
  assert.equal(open.conditions.length, 2);

  // Both legs improving is what would overturn a displacement reading.
  const recovered = [
    { panel: "reabsorption", headline: { change_over_12_months: 0.1 } },
    { panel: "exposed_vs_control_jobs", differential_exposed_minus_control: -1.0 },
  ];
  assert.equal(resolveFalsifier(live, recovered, "2026-11-01").outcome, "FIRED");
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

test("a prediction can name a secondary readout", () => {
  // These ship as an array, so before they carried a key no dotted path could reach
  // them: a prediction about long-term unemployment had no way to say so and had to
  // retreat to the headline. Matched on the key rather than array position, so
  // reordering cannot silently repoint a stored prediction at a different series.
  const panels = [{
    panel: "reabsorption",
    headline: { change_over_12_months: -0.5 },
    secondary_readouts: [
      { overturn_key: "secondary.long_term_unemployed_share", change_over_12_months: 4, latest_value: 27.3 },
      { overturn_key: "secondary.hires_minus_quits", change_over_12_months: 0.1, latest_value: 1.4 },
    ],
  }];

  assert.deepEqual(readPanelField(panels, "reabsorption", "secondary.long_term_unemployed_share"), { ok: true, value: 4 });
  // Bare name defaults to the quantity the panel is placed on.
  assert.deepEqual(readPanelField(panels, "reabsorption", "secondary.hires_minus_quits"), { ok: true, value: 0.1 });
  // A deeper field still resolves.
  assert.deepEqual(readPanelField(panels, "reabsorption", "secondary.hires_minus_quits.latest_value"), { ok: true, value: 1.4 });

  // An unknown name names what IS available, so a malformed prediction is diagnosable
  // rather than a bare failure.
  const miss = readPanelField(panels, "reabsorption", "secondary.made_up");
  assert.equal(miss.ok, false);
  assert.ok(miss.why.includes("secondary.long_term_unemployed_share"), miss.why);

  // Reordering must not change what a stored prediction resolves to.
  const reordered = [{ ...panels[0], secondary_readouts: [...panels[0].secondary_readouts].reverse() }];
  assert.deepEqual(readPanelField(reordered, "reabsorption", "secondary.long_term_unemployed_share"), { ok: true, value: 4 });
});
