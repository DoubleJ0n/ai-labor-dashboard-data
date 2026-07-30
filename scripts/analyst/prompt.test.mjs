// Designed with Claude (Anthropic)
//
// Parsing tests for the three reader-facing outputs. FULL_ANALYSIS is bounded on
// BOTH sides (it sits between TAGLINE and PUBLISHED_NOTE), which is the part that
// is easy to get wrong: a greedy read to end-of-text would swallow the note, and
// the note is the one document the dashboard cannot render without.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parsePass1, parsePass2, noteCompliance, analysisCompliance,
  buildPass1Message, PASS1_SYSTEM,
} from "./prompt.mjs";

test("pass 1 is blind: no prior verdict and no mechanical reading reach it", () => {
  // The prompt now states this as a contract to the model ("WHAT YOU ARE NOT GIVEN"),
  // so the payload has to keep it. Asserted on the assembled message rather than on
  // buildPass1Message's parameter list, because the leak that matters is a field
  // riding in on `panels` or `changes` from somewhere else in the pipeline.
  const panels = [
    { panel: "exposed_vs_control_jobs", differential_exposed_minus_control: -2.5 },
    { panel: "reabsorption", headline: { change_over_12_months: -0.5 } },
  ];
  const changes = {
    previous_run: "2026-07-27T06:28:54Z",
    panels_that_moved: [{ panel: "reabsorption", was: -0.2, now: -0.5 }],
  };
  const msg = buildPass1Message(panels, changes, "news text", false, "2026-07-28");
  const sent = JSON.parse(msg);

  // What moved IS data and must survive: stripping it would be the opposite error.
  assert.ok(sent.what_changed_since_last_analysis, "what-changed must still be sent");
  assert.equal(sent.run_date, "2026-07-28");

  // The conclusions must not be. Searched over the whole serialised body, since a
  // nested field is exactly how one of these would arrive unnoticed.
  for (const banned of [
    "mechanicalState", "mechanical_state", "pairedState", "paired_state",
    "breadth", "gainsVisible", "priorVerdict", "prior_verdict",
    "last_run", "previous_verdict", "REALLOCATION", "INDETERMINATE",
  ]) {
    assert.ok(
      !msg.includes(banned),
      `pass 1's message must not carry ${banned}: the analyst reasons to its own ` +
      `conclusion, and agreement with the rule means nothing if it was shown the rule`,
    );
  }

  // And the prompt says so out loud, so a reader of the published prompt can check it.
  assert.match(PASS1_SYSTEM, /WHAT YOU ARE NOT GIVEN/);
  assert.match(PASS1_SYSTEM, /nor the mechanical stoplight score/);
});

const PASS2 = `NOTIFICATION: New results are in: augmentation reading, no fresh weakness in exposed hiring
TAGLINE: parked gap, quiet month
FULL_ANALYSIS:
The long version, first paragraph.

Second paragraph, which mentions PUBLISHED_NOTE in passing without a colon.
PUBLISHED_NOTE:
The short version.

Second paragraph of the note.`;

test("pass 2 separates the full analysis from the note", () => {
  const r = parsePass2(PASS2);
  assert.ok(r);
  assert.equal(r.notificationLine, "New results are in: augmentation reading, no fresh weakness in exposed hiring");
  assert.equal(r.tagLine, "parked gap, quiet month");
  assert.match(r.fullAnalysis, /^The long version/);
  assert.match(r.fullAnalysis, /without a colon\.$/);
  // The bound that matters: the analysis must not swallow the note.
  assert.doesNotMatch(r.fullAnalysis, /The short version/);
  assert.match(r.publishedNote, /^The short version/);
  assert.match(r.publishedNote, /Second paragraph of the note\.$/);
});

test("a missing full analysis is tolerated, not fatal", () => {
  // Deliberate: the note and notification are what the dashboard needs, and failing
  // the whole run over a missing secondary document would burn a paid call and
  // publish nothing — the strictly worse outcome.
  const withoutFa = `NOTIFICATION: x
TAGLINE: y
PUBLISHED_NOTE:
The note.`;
  const r = parsePass2(withoutFa);
  assert.ok(r);
  assert.equal(r.fullAnalysis, null);
  assert.equal(r.publishedNote, "The note.");
});

test("a missing published note is still fatal", () => {
  const withoutNote = `NOTIFICATION: x
TAGLINE: y
FULL_ANALYSIS:
Only the long one.`;
  assert.equal(parsePass2(withoutNote), null);
});

test("a volunteered dissent field is ignored, not honoured", () => {
  // Pass 2 is no longer asked whether it agrees with pass 1; divergence is computed
  // downstream from values the model never saw. A model that emits the old fields
  // anyway must not get them acted on, or the retired question is back in force
  // without the prompt ever asking it.
  const volunteered = PASS2.replace(
    "TAGLINE: parked gap, quiet month",
    "TAGLINE: parked gap, quiet month\nDISSENT: yes\nDISSENT_NOTE: DISPLACEMENT, on the parked gap",
  );
  const r = parsePass2(volunteered);
  assert.ok(r);
  assert.equal(r.dissented, undefined, "the parser must not surface a dissent flag");
  assert.equal(r.dissentNote, undefined, "the parser must not surface a dissent note");
  // And the documents still separate correctly around the stray labels.
  assert.match(r.fullAnalysis, /^The long version/);
  assert.match(r.publishedNote, /^The short version/);
});

test("counts are reported and carry no pass/fail verdict", () => {
  // Both the 400-500 band and the 10-number ceiling are retired. A quiet month at
  // 120 words is correct, and so is 950 on a month with a development, so there is
  // no band left to be inside — the shape of this return value is the assertion.
  const brief = noteCompliance("Nothing moved this month. " + "word ".repeat(100));
  assert.equal(typeof brief.words, "number");
  assert.equal(typeof brief.numbers, "number");
  assert.ok(brief.lengthBand.includes("quiet"));
  assert.equal(brief.withinWordRange, undefined, "the pass/fail word band must be gone");
  assert.equal(brief.withinNumberCeiling, undefined, "the pass/fail number ceiling must be gone");

  const long = noteCompliance("word ".repeat(900));
  assert.ok(long.lengthBand.includes("extended"));

  // A note carrying many numbers is not a violation; self-sufficiency is a judgement
  // the prompt makes, not one a counter can.
  const numeric = noteCompliance("1 2 3 4 5 6 7 8 9 10 11 12 13 14 15");
  assert.equal(numeric.numbers, 15);
  assert.ok(!("withinNumberCeiling" in numeric));
});

test("analysis stats report absence without throwing", () => {
  assert.deepEqual(analysisCompliance(null), { present: false, words: 0 });
  assert.equal(analysisCompliance("one two three").words, 3);
});

test("pass 1 still requires a verdict and a reasoning log", () => {
  const ok = `VERDICT: AUGMENTATION
CONFOUNDER: NONE
FALSIFIER_PANEL: exposed_vs_control_jobs
FALSIFIER_DIRECTION: falls
FALSIFIER_MAGNITUDE: -4.0 points
FALSIFIER_BY: 2026-10-24
FALSIFIER_PLAIN: the jobs chart moves first
REASONING_LOG:
Working here.`;
  const r = parsePass1(ok);
  assert.equal(r.verdict, "AUGMENTATION");
  assert.equal(r.reasoningLog, "Working here.");
  // CONFOUNDED without a named cause fails its own evidentiary bar.
  assert.equal(parsePass1(ok.replace("AUGMENTATION", "CONFOUNDED")), null);
});

test("the load-bearing panel list is cleaned, capped, and safe when absent", () => {
  // These names choose the two charts on someone's home screen, so the list has to
  // survive ordinary sloppiness (spaces, a repeat, more names than asked for) and has
  // to degrade to empty rather than to something wrong — an empty list makes the widget
  // fall back to its own rotation, which is always safe.
  const base = `VERDICT: DISPLACEMENT
CONFIDENCE: LOW
CONFOUNDER: NONE
OVERTURN_PANEL: reabsorption
OVERTURN_FIELD: headline.change_over_12_months
OVERTURN_COMPARATOR: at_or_above
OVERTURN_VALUE: 0
OVERTURN_BY: 2026-10-27
REASONING_LOG:
Working here.`;

  const withList = base.replace(
    "CONFOUNDER: NONE",
    "LOAD_BEARING_PANELS: exposed_vs_control_jobs, reabsorption , exposed_vs_control_jobs, job_postings_spread, worker_share_of_income\nCONFOUNDER: NONE",
  );
  assert.deepEqual(
    parsePass1(withList).loadBearingPanels,
    ["exposed_vs_control_jobs", "reabsorption", "job_postings_spread"],
    "must trim, drop the duplicate, and cap at three in the order given",
  );

  // Absent entirely (an older model, or a run that skipped the line) and an explicit
  // NONE both mean "no preference", not "no charts".
  assert.deepEqual(parsePass1(base).loadBearingPanels, []);
  assert.deepEqual(
    parsePass1(base.replace("CONFOUNDER: NONE", "LOAD_BEARING_PANELS: NONE\nCONFOUNDER: NONE")).loadBearingPanels,
    [],
  );
});

test("confidence fails safe: anything that is not an explicit HIGH reads LOW", () => {
  const base = `VERDICT: DISPLACEMENT
CONFOUNDER: NONE
FALSIFIER_PANEL: exposed_vs_control_jobs
FALSIFIER_FIELD: differential_exposed_minus_control
FALSIFIER_COMPARATOR: at_or_above
FALSIFIER_VALUE: -1.5
FALSIFIER_BY: 2026-10-24
FALSIFIER_PLAIN: the jobs chart moves first
REASONING_LOG:
Working here.`;

  // The rating gates how the verdict is DISPLAYED: HIGH shows red, LOW caps at
  // amber. So the failure mode of an unreadable rating has to be under-claiming.
  // A missing, malformed or invented rating must never produce a red the analyst
  // did not actually assert.
  assert.equal(parsePass1(base).confidence, "LOW", "absent rating must not read HIGH");
  assert.equal(parsePass1(base.replace("VERDICT:", "CONFIDENCE: MEDIUM\nVERDICT:")).confidence, "MEDIUM");
  assert.equal(parsePass1(base.replace("VERDICT:", "CONFIDENCE: medium\nVERDICT:")).confidence, "MEDIUM");
  // An abbreviation is not a rating. MEDIUM displays as a watch anyway, so degrading it
  // to LOW costs nothing; what must never happen is an unknown value reaching HIGH.
  assert.equal(parsePass1(base.replace("VERDICT:", "CONFIDENCE: MED\nVERDICT:")).confidence, "LOW");
  assert.equal(parsePass1(base.replace("VERDICT:", "CONFIDENCE: very high\nVERDICT:")).confidence, "LOW");

  // And an explicit HIGH is honoured, case-insensitively, or the rating would be
  // unreachable and every verdict would show amber forever.
  assert.equal(parsePass1(base.replace("VERDICT:", "CONFIDENCE: HIGH\nVERDICT:")).confidence, "HIGH");
  assert.equal(parsePass1(base.replace("VERDICT:", "CONFIDENCE: high\nVERDICT:")).confidence, "HIGH");

  const withBasis = parsePass1(
    base.replace("VERDICT:", "CONFIDENCE: LOW\nCONFIDENCE_BASIS: jobs corroborates; postings refutes\nVERDICT:"),
  );
  assert.equal(withBasis.confidenceBasis, "jobs corroborates; postings refutes");
});
