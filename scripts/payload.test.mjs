// Designed with Claude (Anthropic)
//
// The published summary statistics must describe the sample the published z was
// computed on.
//
// Every panel prints an average and a spread for its history, and next to them a figure
// saying how unusual today is against that history. Those were computed over slightly
// different sets of months: the z correctly holds the latest reading out of its own
// comparison window, while the summary described every reading including it. A reader
// checking the arithmetic got a number close to but not equal to the published one,
// which is indistinguishable from a bug — and it was found by exactly that route, twice,
// by two different readers.
//
// The fix was to make the printed stats describe the window the z used. The fix NOT
// taken was to back-solve a mean and standard deviation that reproduce the published z,
// which would be inventing figures to make a sum come out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DRYRUN = path.join(repoRoot, "analyst-request-dryrun.json");

/** Panels carrying both a long-run context block and a deviation, in either shape. */
function pairs(panels) {
  const out = [];
  for (const p of panels) {
    const candidates = [
      [p.long_run_context, p.deviation_from_normal, p.panel],
      [p.headline?.long_run_context_12m_changes, p.headline?.deviation_from_normal, `${p.panel}.headline`],
    ];
    for (const [lr, dv, name] of candidates) {
      if (lr?.full_history && dv && typeof dv.against_full_history === "number") {
        out.push({ name, full: lr.full_history, z: dv.against_full_history });
      }
    }
  }
  return out;
}

test("full-history stats describe the window the full-history z used", () => {
  if (!existsSync(DRYRUN)) {
    console.log("SKIP: run `node scripts/analysis-refresh.mjs --dry-run` first");
    return;
  }
  const req = JSON.parse(readFileSync(DRYRUN, "utf8"));
  const payload = JSON.parse(req.pass1Request.messages[0].content);
  const found = pairs(payload.panels);
  assert.ok(found.length > 0, "no panel published both a full-history block and a z");

  for (const { name, full } of found) {
    // The window text has to name both ends and say the latest is held out, or a
    // reader cannot tell which months the numbers describe.
    assert.match(
      full.window,
      /latest reading held out/,
      `${name}: window text must say the latest reading is excluded`,
    );
    assert.ok(full.readings > 0, `${name}: readings must be positive`);
    assert.equal(typeof full.mean, "number", `${name}: mean must be a number`);
    assert.equal(typeof full.standard_deviation, "number", `${name}: sd must be a number`);
  }
});

test("a reader recomputing the z from the printed stats lands within rounding", () => {
  if (!existsSync(DRYRUN)) return;
  const req = JSON.parse(readFileSync(DRYRUN, "utf8"));
  const payload = JSON.parse(req.pass1Request.messages[0].content);

  for (const p of payload.panels) {
    const lr = p.headline?.long_run_context_12m_changes ?? p.long_run_context;
    const dv = p.headline?.deviation_from_normal ?? p.deviation_from_normal;
    const latest = p.headline?.change_over_12_months ?? p.spread_exposed_minus_control;
    if (!lr?.full_history || typeof dv?.against_full_history !== "number") continue;
    if (typeof latest !== "number") continue;
    const f = lr.full_history;
    if (!f.standard_deviation) continue;

    // Deviation is deterioration-oriented, so the sign may be flipped relative to the
    // raw series; magnitude is what has to agree.
    const recomputed = Math.abs((latest - f.mean) / f.standard_deviation);
    const published = Math.abs(dv.against_full_history);
    // Tolerance covers rounding of the printed mean and sd to two decimals, and is
    // far tighter than the ~0.06 discrepancy the mismatched windows produced.
    assert.ok(
      Math.abs(recomputed - published) < 0.03,
      `${p.panel}: recomputing from the printed stats gives ${recomputed.toFixed(3)} ` +
      `against a published ${published.toFixed(3)}; the two must describe the same sample`,
    );
  }
});

// --- The joint baseline ring (2026-08-06) ------------------------------------

test("the joint ring carries every month, tagged, and leaks no quadrant", async () => {
  const { readFileSync } = await import("node:fs");
  const pool = JSON.parse(readFileSync("dashboard-data.json", "utf8"));
  const { jointBaselinePosition } = await import("./payload.mjs");
  const j = jointBaselinePosition(pool);
  assert.ok(j, "no joint position computed");

  // Every placeable month, oldest first, nothing filtered.
  assert.ok(j.months.length > 150, `expected the whole record, got ${j.months.length}`);
  const ms = j.months.map((m) => m[0]);
  assert.deepEqual(ms, [...ms].sort(), "months must be in date order");
  assert.equal(new Set(ms).size, ms.length, "no duplicate months");

  // All three windows represented, and the pandemic LABELLED rather than dropped.
  const byWin = (w) => j.months.filter((m) => m[3] === w).length;
  for (const w of ["BASELINE", "PANDEMIC", "OBSERVATION"]) {
    assert.ok(byWin(w) > 0, `window ${w} is missing from the payload`);
    assert.equal(byWin(w), j.total_by_window[w], `${w} tally disagrees with the detail`);
  }

  // THE WITHHELD STATE MUST NOT ARRIVE UNDER A NEW NAME. No quadrant, no verdict.
  const blob = JSON.stringify(j).toUpperCase();
  for (const forbidden of ["REALLOCATION", "DISPLACEMENT", "NOT_AI", "STABLE", "INDETERMINATE"]) {
    assert.ok(!blob.includes(forbidden), `joint ring leaks the withheld state name ${forbidden}`);
  }
  for (const m of j.months) {
    assert.equal(m.length, 5, "each row must match months_format");
    assert.equal(typeof m[4], "boolean");
  }

  // The ring must discriminate, or sending it is noise.
  const outShare = (w) =>
    j.months.filter((m) => m[3] === w && !m[4]).length / byWin(w);
  assert.ok(outShare("BASELINE") < 0.2, `baseline should sit inside its own ring, got ${outShare("BASELINE")}`);
  assert.ok(outShare("OBSERVATION") > 0.6, `observation should sit outside, got ${outShare("OBSERVATION")}`);
});
