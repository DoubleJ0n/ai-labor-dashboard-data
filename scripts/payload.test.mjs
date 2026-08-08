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

// --- Gaps are named, and the employment break is not denied (2026-08-07) -------

test("a hole in the joint table is named rather than left to be inferred", async () => {
  const { readFileSync } = await import("node:fs");
  const pool = JSON.parse(readFileSync("dashboard-data.json", "utf8"));
  const { jointBaselinePosition } = await import("./payload.mjs");
  const j = jointBaselinePosition(pool);

  assert.ok(Array.isArray(j.months_absent), "months_absent must always be present");
  const listed = j.months.map((r) => r[0]);
  // Every gap between consecutive rows must appear in months_absent, or a reader
  // walking the table reads a turning point onto the wrong month.
  for (let i = 1; i < listed.length; i++) {
    const a = listed[i - 1], b = listed[i];
    const [ay, am] = a.split("-").map(Number);
    const [by, bm] = b.split("-").map(Number);
    for (let k = 1; k < (by * 12 + bm) - (ay * 12 + am); k++) {
      const t = ay * 12 + (am - 1) + k;
      const ym = `${String(Math.floor(t / 12)).padStart(4, "0")}-${String((t % 12) + 1).padStart(2, "0")}`;
      assert.ok(j.months_absent.includes(ym), `gap month ${ym} is not declared in months_absent`);
    }
  }
  assert.ok(!j.months_absent.some((m) => listed.includes(m)), "a listed month cannot also be absent");
});

test("the decomposition does not claim the employment leg is free of the control break", async () => {
  const { readFileSync } = await import("node:fs");
  const pool = JSON.parse(readFileSync("dashboard-data.json", "utf8"));
  const { buildAnalysisPayload } = await import("./payload.mjs");
  const d = buildAnalysisPayload(pool).find((p) => p.panel === "reabsorption").headline.decomposition;

  // The old wording said seasonal adjustment spared the employment series. It does
  // not: SA removes a seasonal pattern, not a re-weighting break. Measured here, the
  // SA prime-age employed series steps ~1.7M and ~1.0M at the January re-bases, so a
  // note telling the analyst that leg is clean invites exactly the over-reading the
  // rest of this caveat exists to prevent.
  assert.ok(
    !/employment is seasonally adjusted and does not carry the same discontinuity/i.test(d.caveat),
    "the retired claim that employment escapes the control break must not come back",
  );
  assert.match(d.caveat, /employment leg carries the same break/i);
  // And the ratio must still be named as the reliable measure.
  assert.match(d.caveat, /ratio/i);
});

// --- A weak panel is argued down, not ruled out (2026-08-07) -------------------

test("the adoption panel gives its reasons rather than asserting a rule", async () => {
  const { readFileSync } = await import("node:fs");
  const pool = JSON.parse(readFileSync("dashboard-data.json", "utf8"));
  const { buildAnalysisPayload } = await import("./payload.mjs");
  const note = buildAnalysisPayload(pool).find((p) => p.panel === "ai_adoption").panel_role_note;

  // Each of these is a checkable property of the survey. An analyst given them can
  // discount the panel in words a reader can audit; an analyst given only a verdict
  // about the panel can only repeat the verdict.
  for (const [name, re] of [
    ["self-report bias", /self-reported/i],
    ["presence, not redundancy", /role redundant/i],
    ["no firm-level linkage", /no firm-level linkage/i],
    ["firm-count not worker-count", /counts firms rather than workers/i],
  ]) {
    assert.match(note, re, `adoption note lost its reason: ${name}`);
  }

  // And it must not read as a prohibition. The panel stays eligible to be used and to
  // be named as one of the two panels; weak evidence is still evidence.
  assert.match(note, /nothing here forbids/i, "the note must not read as a ban");
  assert.notEqual(
    buildAnalysisPayload(pool).find((p) => p.panel === "ai_adoption").panel_role,
    "does_not_contribute",
    "adoption must remain selectable as one of the two panels",
  );
});

test("the analyst is told that citing a rule is not giving a reason", async () => {
  const { PASS1_SYSTEM } = await import("./analyst/prompt.mjs");
  assert.match(PASS1_SYSTEM, /A RULE IS NOT A REASON/,
    "the rule-is-not-a-reason instruction is the thing that stops label-citation");
  // The phrase that prompted this, named so the guidance stays concrete.
  assert.match(PASS1_SYSTEM, /licenses no attribution/i);
  // It must cut both ways, or it becomes a licence to drop inconvenient findings.
  assert.match(PASS1_SYSTEM, /never a reason to leave a genuine finding out/i);
});

// --- The gate is gone, and the codes say what they contain (2026-08-07) --------

test("no panel is described to the analyst as a gate", async () => {
  const { readFileSync } = await import("node:fs");
  const pool = JSON.parse(readFileSync("dashboard-data.json", "utf8"));
  const { buildAnalysisPayload } = await import("./payload.mjs");
  const panels = buildAnalysisPayload(pool);

  // The gating was removed from verdict.mjs on 2026-07-29; the label survived it by a
  // week and went on telling every run the panel did something it did not. A role name
  // is read as a claim about function, so it has to stay true.
  const adoption = panels.find((p) => p.panel === "ai_adoption");
  assert.equal(adoption.panel_role, "DEPLOYMENT_CONTEXT");
  for (const p of panels) {
    assert.ok(!/GATE/.test(p.panel_role ?? ""), `${p.panel} still carries a GATE role`);
  }
  // And the note must not reintroduce it in prose.
  assert.ok(!/says GATE/i.test(adoption.panel_role_note));
});

test("the jobs panel says what its industry codes actually contain", async () => {
  const { readFileSync } = await import("node:fs");
  const pool = JSON.parse(readFileSync("dashboard-data.json", "utf8"));
  const { buildAnalysisPayload } = await import("./payload.mjs");
  const jobs = buildAnalysisPayload(pool).find((p) => p.panel === "exposed_vs_control_jobs");

  // An analyst can generate competing hypotheses; it cannot derive what an industry
  // code contains by reasoning about the number. That is the line this payload draws
  // between facts about the instrument (supplied) and alternative explanations (not).
  const c = jobs.what_these_industry_codes_contain;
  assert.ok(c, "the composition note is the only place the analyst learns this");
  assert.match(c, /motion picture/i, "the information-is-not-tech trap must stay named");
  assert.match(c, /temporary help|staffing/i, "temp help turns early in any slowdown");
  assert.match(c, /construction/i, "the control leg's rate sensitivity must stay named");

  // Recent months are the least reliable, and the whole current finding rests on them.
  assert.match(jobs.how_this_survey_revises, /preliminary|revised/i);
  assert.match(jobs.how_this_survey_revises, /birth-death/i);
});

// --- The payload argues nothing (2026-08-07, replacing the marking approach) ----

test("no panel hands the analyst a pre-built conclusion, marked or otherwise", async () => {
  const { readFileSync } = await import("node:fs");
  const pool = JSON.parse(readFileSync("dashboard-data.json", "utf8"));
  const { buildAnalysisPayload } = await import("./payload.mjs");
  const panels = buildAnalysisPayload(pool);

  // The marking approach lasted one analyst run. Attribution fixes a claim's
  // PROVENANCE and does nothing about its DIRECTION, and every opinion we had added
  // pointed the same way; the run listed them as advocacy and noted the pattern. So
  // the opinions are gone rather than labelled, and the label is gone with them --
  // a payload with no house arguments in it has nothing to attribute.
  for (const p of panels) {
    const blob = JSON.stringify(p);
    assert.ok(!/OUR READING, WHICH YOU MAY REJECT|OUR INFERENCE, NOT A PROPERTY/.test(blob),
      `${p.panel} still carries a marked house opinion; remove the claim, not just the label`);
  }

  // The wage panel's pre-built displacement argument is gone. Its PREMISE stays: a
  // shrinking group's average rises when lower-paid workers leave. The analyst can
  // take the step from premise to conclusion, and the step has to be its own.
  const wages = panels.find((p) => p.panel === "exposed_vs_control_wages").measurement_artifact;
  assert.equal(wages.rising_pay_as_a_displacement_signature, undefined,
    "the pre-built argument must not come back, in this or any renamed field");
  assert.match(wages.composition_artifact, /average pay across the group RISES/,
    "the mechanism is a fact and stays");

  // Adoption keeps the four survey properties and lost the inference about whether a
  // fifth of firms is 'enough'. The level is in the payload; the analyst can judge it.
  const adoption = panels.find((p) => p.panel === "ai_adoption").panel_role_note;
  assert.ok(!/already past the level/i.test(adoption),
    "whether a fifth of firms is sufficient for anything is the analyst's call");
  assert.match(adoption, /self-reported/i, "the survey properties are facts and stay");

  // The switcher premium names both live explanations and argues for neither.
  const r = panels.find((p) => p.panel === "individual_wage_growth").switcher_premium_reading;
  if (r !== "no reading available") {
    assert.match(r, /Two explanations fit that/,
      "naming one reading and not its rival is a thumb on the scale whatever the label says");
    assert.match(r, /composition/i);
  }
});

// --- The 40-hour bar is ours, and it is past the instrument (2026-08-07) ------

test("the METR reference bar is attributed and admits it is beyond the benchmark", async () => {
  const { readFileSync } = await import("node:fs");
  const pool = JSON.parse(readFileSync("dashboard-data.json", "utf8"));
  const metrRecords = JSON.parse(readFileSync("data/metr/time_horizons.json", "utf8")).records ?? [];
  const { buildAnalysisPayload } = await import("./payload.mjs");
  const b = buildAnalysisPayload(pool, { metrRecords, metrTop5: [] })
    .find((p) => p.panel === "ai_capability_metr").our_reference_bar;

  // METR publishes horizons at reliability levels. It publishes no 40-hour bar; we
  // chose that number because a working week is a rhetorical reference point.
  assert.match(b.bar_note, /OURS, NOT METR'S/);

  // The bar is 2400 minutes and this panel's own caveat puts reliable measurement at
  // ~960. A projection to it extrapolates past the instrument, and saying so is the
  // difference between a reference point and a forecast.
  assert.ok(b.bar_minutes > b.instrument_ceiling_minutes * 2,
    "if the bar ever falls inside the measurable range this warning must be revisited");
  assert.match(b.bar_is_beyond_the_instrument, /PLACEMENT WAS DELIBERATE/);

  // A single date would be the dishonest version; the app fits four ways and spreads.
  assert.match(b.projection_caveat, /ONE naive log-linear fit/);
  assert.match(b.projection_caveat, /Do not quote it as the projection/);

  // The plateau trap is a property of the benchmark: two different worlds produce the
  // same curve. Stated as a limit, never as a hint about which one is happening.
  assert.match(b.a_plateau_here_is_ambiguous, /saturation/i);
  assert.match(b.a_plateau_here_is_ambiguous, /plateau well below the ceiling/i);
});

// --- Three defects an analyst run surfaced (2026-08-07) ------------------------

test("the decomposition never contradicts the headline it decomposes", async () => {
  const { readFileSync } = await import("node:fs");
  const pool = JSON.parse(readFileSync("dashboard-data.json", "utf8"));
  const { buildAnalysisPayload } = await import("./payload.mjs");
  const h = buildAnalysisPayload(pool).find((p) => p.panel === "reabsorption").headline;
  const d = h.decomposition;
  if (!d) return;

  // It used to branch on the employed LEVEL alone, so it could announce that the share
  // fell in a month the share had not moved. The ratio is the reliable series — its
  // numerator and denominator re-base together in January while each leg alone steps —
  // so the ratio decides the sentence and the legs explain it.
  const flat = h.change_over_12_months === 0;
  if (flat) {
    assert.match(d.reading, /SHARE DID NOT MOVE/,
      "a flat headline cannot be narrated as a fall, whatever the levels do");
    assert.match(d.reading, /re-basing/i, "and the apparent disagreement has to be explained");
  }
  if (h.change_over_12_months < 0) assert.match(d.reading, /share fell/i);
  if (h.change_over_12_months > 0) assert.match(d.reading, /share ROSE/);
});

test("the field that places the reabsorption axis is addressable for an overturn", async () => {
  const { readFileSync } = await import("node:fs");
  const pool = JSON.parse(readFileSync("dashboard-data.json", "utf8"));
  const { buildAnalysisPayload } = await import("./payload.mjs");
  const r = buildAnalysisPayload(pool).find((p) => p.panel === "reabsorption");

  // Every supporting readout advertised a path while the headline — the one field that
  // PLACES the axis — shipped null, so an analyst looking for something to register
  // against found only the lesser fields. The prompt's own worked example is this path.
  assert.equal(r.headline.overturn_key, "headline.change_over_12_months");
  for (const s of r.secondary_readouts ?? []) {
    assert.ok(s.overturn_key, `secondary ${s.display_label} lost its overturn_key`);
  }
});

test("the reasoning log is uncapped, because it is the only record of the reasoning", async () => {
  const { PASS1_SYSTEM } = await import("./analyst/prompt.mjs");
  // A budget here saves ~11% of a run and destroys the only artifact that records why
  // a verdict was reached. The truncation it was meant to prevent is handled by the
  // ceiling plus a hard failure, neither of which costs an audit trail.
  const flat = PASS1_SYSTEM.replace(/\s+/g, " ");
  assert.match(PASS1_SYSTEM, /UNCAPPED, and uncapped on purpose/);
  assert.match(flat, /ONLY SURVIVING RECORD/i,
    "the reason the log is uncapped is the reason it must stay uncapped");

  // No word or length budget may come back on this field. If truncation recurs the
  // answer is a higher ceiling, not a shorter log.
  assert.ok(!/UNDER ABOUT [\d,]+ WORDS/i.test(flat),
    "a length budget on the sole audit artifact is the trade that was already rejected");

  // And the analyst is told why length here is free, so it does not compress defensively.
  assert.match(flat, /run is DISCARDED rather than published/i);
});

// --- A summary string may not overstate its own panel (2026-08-07) ------------

test("the streak names the line it actually crossed", async () => {
  const { readFileSync } = await import("node:fs");
  const pool = JSON.parse(readFileSync("dashboard-data.json", "utf8"));
  const { buildAnalysisPayload } = await import("./payload.mjs");
  const panels = buildAnalysisPayload(pool);

  // "watch" is the label for past the ATTENTION line and short of the ALARM line. It
  // printed as "modestly past its alarm line", which reads as an alarm crossing that
  // the panel's own deviation, alarm_line and trigger all deny. Two analyst runs
  // caught it; the second was auditing for directional lean and found this as the only
  // one, pointing toward alarm.
  for (const p of panels) {
    const dv = p.deviation_from_normal ?? p.headline?.deviation_from_normal;
    const streak = p.streak ?? p.headline?.streak;
    if (!dv || !streak || typeof dv.against_fixed_pre2020_baseline !== "number") continue;
    const z = dv.against_fixed_pre2020_baseline;
    if (typeof dv.alarm_line !== "number") continue;

    if (z < dv.alarm_line && /past its alarm line/.test(streak)) {
      assert.match(streak, /short of its alarm line/,
        `${p.panel}: z=${z} is inside alarm_line=${dv.alarm_line}, so the streak must not ` +
        "claim an alarm crossing without saying it is short of it");
    }
    if (z >= dv.alarm_line) {
      assert.ok(!/short of its alarm line/.test(streak),
        `${p.panel}: z=${z} is past alarm_line=${dv.alarm_line}; the streak understates it`);
    }
  }
});

test("a run that hits its ceiling is discarded, not published", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync("scripts/analysis-refresh.mjs", "utf8");

  // The failure this guards is silent by construction: the structured fields serialise
  // BEFORE the reasoning log, so a truncation removes the audit trail and leaves a
  // verdict that parses cleanly and looks complete. A warning is not enough for that,
  // because nobody reads a warning inside a green run.
  const guard = src.slice(src.indexOf("stop_reason"), src.indexOf("stop_reason") + 900);
  assert.match(guard, /throw new Error/,
    "a truncated pass must abort the run, not warn and continue");
  assert.ok(!/console\.warn\([^)]*ceiling/i.test(src),
    "the warn-and-continue version must not come back alongside the throw");

  // THE CEILING IS NOT A NUMBER IN THIS FILE ANY MORE. It went 1500 -> 16000 -> 24000
  // -> 32000 in under a year, each raise following a truncation, which means every
  // value it ever held was one a later run proved too small. A constant here encodes
  // today's guess about how much a model needs to think, and the premise of paying for
  // this job is that a better model may think longer.
  assert.ok(!/const MAX_TOKENS = \d/.test(src),
    "a hardcoded ceiling is a guess about how much a future model needs to think");
  assert.match(src, /max_tokens: await maxTokensFor\(model\)/,
    "the ceiling must be asked of the model rather than written down here");

  // The fallback covers an unreachable Models API and must err large: a fallback that is
  // too big is rejected by the API with a clear error, one that is too small truncates
  // silently. Large is the recoverable direction.
  const fb = src.match(/const MAX_TOKENS_FALLBACK = (\d+)/);
  assert.ok(fb && Number(fb[1]) >= 64000,
    "the fallback must stay generous; too small fails silently, too large fails loudly");
});
