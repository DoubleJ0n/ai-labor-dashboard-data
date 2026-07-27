// Designed with Claude (Anthropic)
//
// The paired state is the discriminator the dashboard was missing, and the ONE
// value that is computed every run and deliberately withheld from the model.
// Both properties are tested here: the 2x2 truth table, and the blindness.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pairedState, pairedPath, PAIRED_STATES } from "./pairedState.mjs";
import { buildAnalysisPayload } from "../payload.mjs";
import { PAIRED_STATE_AXIS_Z } from "../config.mjs";

const MOVING = PAIRED_STATE_AXIS_Z + 0.5;
const FLAT = PAIRED_STATE_AXIS_Z - 0.5;

test("the 2x2 truth table", () => {
  assert.equal(pairedState(MOVING, FLAT).state, "REALLOCATION");
  assert.equal(pairedState(MOVING, MOVING).state, "DISPLACEMENT");
  assert.equal(pairedState(FLAT, MOVING).state, "NOT_AI");
  assert.equal(pairedState(FLAT, FLAT).state, "STABLE");
});

test("the axis threshold is inclusive at exactly the registered line", () => {
  // A reading sitting exactly on the line counts as moving. Stated in a test
  // because "at or above" versus "above" silently changes which quadrant a
  // borderline month lands in, and that is the whole output of this module.
  assert.equal(pairedState(PAIRED_STATE_AXIS_Z, FLAT).attribution.moving, true);
  assert.equal(pairedState(FLAT, PAIRED_STATE_AXIS_Z).reabsorption.moving, true);
});

test("a maximally negative gap with a healthy aggregate is REALLOCATION, not DISPLACEMENT", () => {
  // The failure this whole design exists to prevent. Perfect reallocation — every
  // worker re-employed in a control industry — produces the most negative
  // attribution reading obtainable, and it is NOT displacement.
  const s = pairedState(6.0, -1.0);
  assert.equal(s.state, "REALLOCATION");
  assert.equal(s.attribution.label, "gap widening");
  assert.equal(s.reabsorption.label, "aggregate holding");
});

test("an unplaceable axis is INDETERMINATE and never collapses to flat", () => {
  // A null z means no clean baseline exists. Reading it as "flat" would turn
  // missing history into a positive finding of stability.
  assert.equal(pairedState(null, MOVING).state, "INDETERMINATE");
  assert.equal(pairedState(MOVING, null).state, "INDETERMINATE");
  assert.equal(pairedState(null, null).state, "INDETERMINATE");
  assert.equal(pairedState(null, MOVING).attribution.moving, null);
  assert.equal(pairedState(null, MOVING).attribution.label, "cannot be placed");
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
  const path = pairedPath(attribution, reabsorption, () => MOVING, 24);
  assert.deepEqual(path.map((p) => p.month), ["2026-01", "2026-03"]);
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
  assert.deepEqual([...new Set(roles)].sort(), ["ATTRIBUTION", "REABSORPTION"]);
  for (const r of roles) assert.ok(!Object.keys(PAIRED_STATES).includes(r));
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
