// Designed with Claude (Anthropic)
import { test } from "node:test";
import assert from "node:assert/strict";
import { smoothedForAxis, pairedState } from "./pairedState.mjs";
import { REABSORPTION_AXIS_SMOOTHING_MONTHS, REABSORPTION_AXIS_SMOOTHING_MIN_READINGS } from "../config.mjs";

const dated = (...v) => v.map((x, i) => (x == null ? null : [`2026-${String(i + 1).padStart(2, "0")}`, x])).filter(Boolean);
const at = (s, m) => s.find(([k]) => k === m)?.[1];

test("the registered window is three months with a two-reading floor", () => {
  assert.equal(REABSORPTION_AXIS_SMOOTHING_MONTHS, 3);
  assert.equal(REABSORPTION_AXIS_SMOOTHING_MIN_READINGS, 2);
});

test("the axis is the mean of the latest three calendar months", () => {
  const s = smoothedForAxis(dated(0.0, -0.3, 0.0, 0.3, -0.5, 0.0));
  // January has one reading, under the floor, so the series starts in February.
  assert.equal(s[0][0], "2026-02");
  assert.equal(at(s, "2026-02"), -0.15);
  assert.equal(at(s, "2026-03"), -0.1);
  assert.equal(at(s, "2026-04"), 0);
  assert.equal(at(s, "2026-06"), -0.0667);
});

test("one missing print costs nothing; two in a row leave the month unplaceable", () => {
  const one = smoothedForAxis(dated(0.2, 0.2, null, 0.4, 0.4));
  assert.equal(at(one, "2026-04"), 0.3);
  assert.equal(at(one, "2026-05"), 0.4);
  const two = smoothedForAxis(dated(0.2, null, null, 0.4, 0.4));
  assert.equal(at(two, "2026-04"), undefined);
  assert.equal(at(two, "2026-05"), 0.4);
});

test("an exactly flat quarter is not deterioration, matching the strict raw rule and the app", () => {
  const s = smoothedForAxis(dated(0.1, -0.1, 0.0));
  const latest = s[s.length - 1][1];
  assert.equal(latest, 0);
  assert.equal(pairedState(1.0, latest, true).state, "REALLOCATION");
});
