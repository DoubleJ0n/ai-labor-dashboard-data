// Designed with Claude (Anthropic)
//
// The paired state is the discriminator the dashboard was missing, and the ONE
// value that is computed every run and deliberately withheld from the model.
// Both properties are tested here: the 2x2 truth table, and the blindness.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pairedState, pairedPath, PAIRED_STATES } from "./pairedState.mjs";
import { buildAnalysisPayload } from "../payload.mjs";
import {
  ATTRIBUTION_AXIS_Z, REABSORPTION_AXIS_LINE, ATTRIBUTION_SUSTAIN_MONTHS,
} from "../config.mjs";

// The axes are measured in DIFFERENT UNITS and have separate lines: attribution is
// a z against its own fixed baseline, reabsorption is points below a fixed 2019
// reference level. They briefly shared a threshold, which read tidily and hid the
// fact that a two-industry differential and an economy-wide employment level are
// not the same kind of quantity.
const A_MOVING = ATTRIBUTION_AXIS_Z + 0.5;   // gap wider than its 2010s norm
const A_FLAT = ATTRIBUTION_AXIS_Z - 0.5;     // gap narrower than norm
const R_MOVING = REABSORPTION_AXIS_LINE + 0.5; // employment falling
const R_FLAT = REABSORPTION_AXIS_LINE - 0.5;   // employment rising

test("the 2x2 truth table", () => {
  assert.equal(pairedState(A_MOVING, R_FLAT).state, "REALLOCATION");
  assert.equal(pairedState(A_MOVING, R_MOVING).state, "DISPLACEMENT");
  assert.equal(pairedState(A_FLAT, R_MOVING).state, "NOT_AI");
  assert.equal(pairedState(A_FLAT, R_FLAT).state, "STABLE");
});

test("the axis threshold is inclusive at exactly the registered line", () => {
  // A reading sitting exactly on the line counts as moving. Stated in a test
  // because "at or above" versus "above" silently changes which quadrant a
  // borderline month lands in, and that is the whole output of this module.
  assert.equal(pairedState(ATTRIBUTION_AXIS_Z, R_FLAT).attribution.moving, true);
  assert.equal(pairedState(A_FLAT, REABSORPTION_AXIS_LINE).reabsorption.moving, true);
});

test("a maximally negative gap with a healthy aggregate is REALLOCATION, not DISPLACEMENT", () => {
  // The failure this whole design exists to prevent. Perfect reallocation — every
  // worker re-employed in a control industry — produces the most negative
  // attribution reading obtainable, and it is NOT displacement.
  // Attribution 6 sigma past its line; reabsorption 1 point ABOVE its 2019
  // reference, i.e. a negative shortfall, so the aggregate is not deteriorating.
  const s = pairedState(6.0, -1.0, true);
  assert.equal(s.state, "REALLOCATION");
  assert.equal(s.attribution.label, "gap wide and holding");
  assert.equal(s.reabsorption.label, "aggregate holding");
});

test("the reabsorption axis reads a CHANGE against raw zero", () => {
  // TWO EARLIER VERSIONS FAILED HERE, in opposite directions, and both are pinned
  // so neither comes back.
  //
  // First it z-scored the 12-month change against 2010-2019. That decade is one
  // continuous recovery, rising about +0.53 a year, so positive changes were
  // structurally normal in the baseline and any mature expansion read as
  // deteriorating. It returned 1.77 on first real data, mostly "the recovery ended".
  //
  // Then it read the LEVEL against the 2019 mean. That anchored the boundary to a
  // cyclical peak, and almost every month in history sits below a peak: at a zero
  // line it would have called 100% of 2011-2013 and 76% of 2014-2019 displacement.
  //
  // A change against RAW ZERO has neither failure. No distribution, so nothing to
  // contaminate; no reference year, so no peak to anchor to. Verified against the
  // record before adoption: it never calls the 2014-2019 boom displacement.

  // Employment RISING year-over-year: the aggregate is holding, whatever the gap does.
  assert.equal(pairedState(A_MOVING, -0.5).state, "REALLOCATION");
  assert.equal(pairedState(A_MOVING, -0.5).reabsorption.moving, false);

  // Employment FALLING: the aggregate is deteriorating.
  assert.equal(pairedState(A_MOVING, 0.5).state, "DISPLACEMENT");

  // Exactly flat sits ON the line and counts as the moving side. A boundary case
  // that is vanishingly rare on a continuous measure, resolved toward SHOWING
  // deterioration rather than hiding it, which is the right bias for an
  // early-warning display and matches the attribution axis convention.
  assert.equal(pairedState(A_MOVING, REABSORPTION_AXIS_LINE).reabsorption.moving, true);
});

test("both lines sit at zero, because the grid displays rather than triggers", () => {
  // Pinned as a registered fact. If either line drifts off zero, someone has
  // reintroduced a threshold into a display, which is the confusion this design
  // exists to undo. The trigger belongs in the stoplight.
  assert.equal(ATTRIBUTION_AXIS_Z, 0);
  assert.equal(REABSORPTION_AXIS_LINE, 0);
});

test("an unplaceable axis is INDETERMINATE and never collapses to flat", () => {
  // A null z means no clean baseline exists. Reading it as "flat" would turn
  // missing history into a positive finding of stability.
  assert.equal(pairedState(null, R_MOVING).state, "INDETERMINATE");
  assert.equal(pairedState(A_MOVING, null).state, "INDETERMINATE");
  assert.equal(pairedState(null, null).state, "INDETERMINATE");
  assert.equal(pairedState(null, R_MOVING).attribution.moving, null);
  assert.equal(pairedState(null, R_MOVING).attribution.label, "cannot be placed");
});

test("every state carries plain-language text", () => {
  for (const [name, v] of Object.entries(PAIRED_STATES)) {
    assert.ok(v.plain?.length > 0, `${name} has no plain label`);
    assert.ok(v.reading?.length > 0, `${name} has no reading`);
    // Plain-language means plain: no axis jargon in the user-facing label.
    assert.doesNotMatch(v.plain, /reabsorption|attribution|z-score/i);
  }
});

test("the path drops months missing either axis rather than carrying forward", () => {
  const attribution = [["2026-01", 1], ["2026-02", 2], ["2026-03", 3]];
  const reabsorption = [["2026-01", 1], ["2026-03", 3]]; // 2026-02 absent
  const path = pairedPath(attribution, reabsorption, () => A_MOVING, 24);
  assert.deepEqual(path.map((p) => p.month), ["2026-01", "2026-03"]);
});

// --- The gap has to HOLD, not merely be wide (2026-07-28) --------------------
//
// The failure this fixes: the attribution axis was established by a single month at
// or past its line, and the gap has been past that line since 2023, so the axis never
// changed the quadrant. Every state change came from the vertical axis — an
// economy-wide employment change an ordinary recession moves — which meant the
// cyclical half was deciding the discriminator on its own.

test("a weak aggregate cannot reach DISPLACEMENT on a gap that has not held", () => {
  // The whole point of the change, stated as the case it prevents: the aggregate is
  // deteriorating (a recession would do this), the gap has gone wide but only just.
  // That is an ordinary downturn until the AI-specific axis confirms.
  const notYet = pairedState(A_MOVING, R_MOVING, false);
  assert.equal(notYet.state, "NOT_AI");
  // And it must not describe a wide gap as a flat one while it waits.
  assert.equal(notYet.attribution.wideThisMonth, true);
  assert.match(notYet.attribution.label, /not yet held/);

  // Once it has held, the same two readings are DISPLACEMENT.
  assert.equal(pairedState(A_MOVING, R_MOVING, true).state, "DISPLACEMENT");
});

test("an unheld gap with a healthy aggregate is STABLE, not REALLOCATION", () => {
  assert.equal(pairedState(A_MOVING, R_FLAT, false).state, "STABLE");
  assert.equal(pairedState(A_MOVING, R_FLAT, true).state, "REALLOCATION");
});

test("the path requires a real run of wide readings before promoting a quadrant", () => {
  // Four months: the gap crosses its line at the second and stays. With a run
  // requirement of three, the first month it can be called held is the fourth.
  const months = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05"];
  const attribution = months.map((m) => [m, 1]);
  const reabsorption = months.map((m) => [m, R_MOVING]); // aggregate deteriorating throughout
  const zByMonth = {
    "2026-01": A_FLAT, "2026-02": A_MOVING, "2026-03": A_MOVING,
    "2026-04": A_MOVING, "2026-05": A_MOVING,
  };
  // zOf receives the series up to and including the month being placed.
  const zOf = (slice) => zByMonth[slice[slice.length - 1][0]];
  const path = pairedPath(attribution, reabsorption, zOf, 24);

  assert.equal(ATTRIBUTION_SUSTAIN_MONTHS, 3, "this test is written for a run of three");
  assert.deepEqual(
    path.map((p) => `${p.month}:${p.state}`),
    [
      "2026-01:INDETERMINATE", // too little history to judge a run
      "2026-02:INDETERMINATE",
      "2026-03:NOT_AI",        // wide for two, not yet held: an ordinary downturn
      "2026-04:DISPLACEMENT",  // third consecutive wide reading
      "2026-05:DISPLACEMENT",
    ],
  );
});

test("a missing month does not break a run the gap never actually broke", () => {
  // October 2025 has no prime-age employment print, so the path drops it. The run is
  // a fact about the ATTRIBUTION series, so it has to be computed before that drop —
  // otherwise a hole in a different series silently resets the confirmation clock.
  const months = ["2026-01", "2026-02", "2026-03", "2026-04"];
  const attribution = months.map((m) => [m, 1]);
  const reabsorption = [["2026-01", R_MOVING], ["2026-04", R_MOVING]]; // two absent
  const path = pairedPath(attribution, reabsorption, () => A_MOVING, 24);
  const last = path[path.length - 1];
  assert.equal(last.month, "2026-04");
  assert.equal(last.state, "DISPLACEMENT", "the gap was wide for all four attribution months");
});

// --- The blindness -----------------------------------------------------------
//
// Enforced as a property of the payload rather than a convention, because the
// failure mode is additive: someone adds a helpful field later and the analyst
// silently becomes a formatter for a rule engine.

/** Minimal pool: enough for the payload to build without throwing. */
function stubPool() {
  // Values must actually VARY, or every standard deviation is zero, every
  // deviation block comes back null, and the leak test passes because the
  // interesting fields were never populated. Deterministic wobble, no Math.random.
  const monthly = (start, n, v) => {
    const out = [];
    let [y, m] = start.split("-").map(Number);
    for (let i = 0; i < n; i++) {
      const wobble = Math.sin(i * 1.7) * 1.5 + Math.sin(i * 0.31) * 0.8;
      out.push({ date: `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-01`, value: v + wobble });
      if (++m > 12) { m = 1; y++; }
    }
    return out;
  };
  const ids = [
    "USINFO", "USPBS", "USFIRE", "USCONS", "USLAH", "USEHS",
    "CES5000000003", "CES6000000003", "CES5500000003",
    "CES2000000003", "CES7000000003", "CES6500000003",
    "LNS12300060", "LNS13025703", "JTSHIR", "JTSQUR", "U6RATE", "UNRATE",
    "CGBD2024", "T10Y2Y", "GDICOMP", "GDI", "PRS85006091", "OPHNFB",
  ];
  const series = {};
  for (const id of ids) series[id] = monthly("2010-01", 200, 50);
  return { fred: { series }, capability: { slots: [], points: [] } };
}

/** Every (key, value) pair in a nested structure, flattened. */
function* walk(node, keyPath = "") {
  if (Array.isArray(node)) {
    for (const v of node) yield* walk(v, keyPath);
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      yield [k, v, keyPath ? `${keyPath}.${k}` : k];
      yield* walk(v, keyPath ? `${keyPath}.${k}` : k);
    }
  }
}

test("the computed paired state never reaches the analyst payload", () => {
  const payload = buildAnalysisPayload(stubPool(), { todayYm: "2026-09" });

  // What is banned is the ANSWER, not the concept. The attribution panel is
  // required to explain in prose that it measures reallocation — that is the
  // whole point of Task 5's metadata — so a substring search for "reallocation"
  // would forbid the thing the spec asks for. The leak to guard against is the
  // computed state arriving as a FIELD: a key naming the pairing, or a value that
  // IS one of the four state names.
  const stateNames = new Set(Object.keys(PAIRED_STATES));
  for (const [key, value, path] of walk(payload)) {
    assert.doesNotMatch(key, /paired|quadrant/i, `payload key "${path}" names the paired state`);
    if (typeof value === "string") {
      assert.ok(
        !stateNames.has(value.trim()),
        `payload field "${path}" has the computed state "${value}" as its value`,
      );
    }
  }
});

test("the panel_role labels do not smuggle the verdict in", () => {
  // ATTRIBUTION and REABSORPTION describe what a panel MEASURES, which the
  // analyst needs. Neither may be one of the four state names, or the role field
  // would be the answer wearing a different label.
  const payload = buildAnalysisPayload(stubPool(), { todayYm: "2026-09" });
  const roles = payload.map((p) => p.panel_role).filter(Boolean);
  // The vocabulary is documented at the top of payload.mjs. Pinned here so a new
  // role has to be a deliberate addition: the prompt says a role BINDS, so an
  // unrecognised one is an instruction to the model that nobody reviewed.
  assert.deepEqual(
    [...new Set(roles)].sort(),
    [
      "ATTRIBUTION", "COMPOSITION_CONTROL", "CONFOUNDER_CHECK", "DEPLOYMENT_GATE",
      "DESCRIPTIVE", "GAINS_TEST", "REABSORPTION", "does_not_contribute",
    ],
  );
  for (const r of roles) assert.ok(!Object.keys(PAIRED_STATES).includes(r));
});

test("every panel carries a panel_role, and every role explains itself", () => {
  // The prompt says a role binds WHERE ONE IS PRESENT, which made absence the most
  // permissive state available: a panel with no role ran unconstrained, and the
  // panels most likely to be over-read were exactly the ones that had never been
  // given one. Coverage is the fix, so coverage is the test.
  const payload = buildAnalysisPayload(stubPool(), { todayYm: "2026-09" });
  const missing = payload.filter((p) => !p.panel_role).map((p) => p.panel);
  assert.deepEqual(missing, [], `panels with no panel_role: ${missing.join(", ")}`);

  // A bare label is not a role. Each one has to say what the panel can and cannot
  // establish, or it is a category name doing no work.
  const unexplained = payload.filter((p) => !p.panel_role_note).map((p) => p.panel);
  assert.deepEqual(unexplained, [], `panel_role with no note: ${unexplained.join(", ")}`);
});

test("payload.mjs does not import the paired-state module", async () => {
  // The structural guarantee: the dependency points from pairedState -> payload,
  // never the reverse, so the state cannot be added to the payload by accident.
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../payload.mjs", import.meta.url), "utf8"));
  assert.doesNotMatch(src, /pairedState/, "payload.mjs must not know the paired state exists");
});

test("both axes are still sent, even though the state is not", () => {
  // Withholding the answer must not become withholding the evidence.
  const payload = buildAnalysisPayload(stubPool(), { todayYm: "2026-07" });
  const names = payload.map((p) => p.panel);
  assert.ok(names.includes("exposed_vs_control_jobs"), "attribution axis missing");
  assert.ok(names.includes("reabsorption"), "reabsorption axis missing");
});
