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
