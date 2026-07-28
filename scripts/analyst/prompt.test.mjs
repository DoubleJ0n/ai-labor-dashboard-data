// Designed with Claude (Anthropic)
//
// Parsing tests for the three reader-facing outputs. FULL_ANALYSIS is bounded on
// BOTH sides (it sits between DISSENT_NOTE and PUBLISHED_NOTE), which is the part
// that is easy to get wrong: a greedy read to end-of-text would swallow the note,
// and the note is the one document the dashboard cannot render without.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePass1, parsePass2, noteCompliance, analysisCompliance } from "./prompt.mjs";

const PASS2 = `NOTIFICATION: New results are in: augmentation reading, no fresh weakness in exposed hiring
TAGLINE: parked gap, quiet month
DISSENT: no
DISSENT_NOTE: NONE
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
DISSENT: no
DISSENT_NOTE: NONE
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
DISSENT: no
FULL_ANALYSIS:
Only the long one.`;
  assert.equal(parsePass2(withoutNote), null);
});

test("dissent is captured alongside the two documents", () => {
  const dissenting = PASS2
    .replace("DISSENT: no", "DISSENT: yes")
    .replace("DISSENT_NOTE: NONE", "DISSENT_NOTE: DISPLACEMENT, on the parked exposed-vs-control gap");
  const r = parsePass2(dissenting);
  assert.equal(r.dissented, true);
  assert.match(r.dissentNote, /^DISPLACEMENT/);
  assert.match(r.fullAnalysis, /^The long version/);
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
  assert.equal(parsePass1(base.replace("VERDICT:", "CONFIDENCE: MEDIUM\nVERDICT:")).confidence, "LOW");
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
