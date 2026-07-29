// Designed with Claude (Anthropic)
//
// The paired state — the mechanical discriminator, and the one thing on this
// dashboard that is computed every run and never shown to the analyst.
//
// WHY THE TWO AXES
//
// The exposed-vs-control gap was carrying the verdict and it cannot bear that
// weight. If AI eliminates 100 jobs in information and professional services and
// all 100 of those workers are hired in construction and health care, exposed
// employment falls, control employment rises, the gap widens from both ends at
// once, and total employment is unchanged with every worker landing somewhere.
// Perfect reallocation produces a maximally negative gap and zero net
// displacement. So that panel measures reallocation, and it cannot distinguish
// "these jobs were destroyed" from "these jobs moved."
//
// It is still necessary — it is the only thing letting anything be attributed to
// AI-exposed work rather than to the general economy — but it is an ATTRIBUTION
// axis. Crossed with a REABSORPTION axis it becomes a discriminator:
//
//                        aggregate holding      aggregate deteriorating
//   gap wide, held        REALLOCATION           DISPLACEMENT
//   gap flat or unheld    STABLE                 NOT_AI
//
// "HELD" IS THE PART ADDED 2026-07-28. A single month at or past the line used to
// establish the attribution axis, and the gap has been past that line continuously
// since 2023 — so in practice the attribution axis never changed the quadrant, and
// every state change on this grid came from the vertical axis. That axis is an
// economy-wide employment change, which an ordinary recession moves with no AI
// content whatever, and it crossed its own line eight times in eighteen months. The
// discriminator was being decided by the half that cannot discriminate. Requiring
// the gap to hold for ATTRIBUTION_SUSTAIN_MONTHS gives the AI-specific axis a say:
// until it has held, a deteriorating aggregate lands in NOT_AI, which is what an
// ordinary downturn is.
//
// WHY THE ANALYST NEVER SEES IT
//
// The analyst receives the underlying panels for both axes and reasons to its own
// conclusion. It does not receive this state. Handed the answer, an analyst stops
// being an analyst and becomes a formatter for a rule engine, which is the thing
// this design deliberately moved away from — and a rule engine wearing prose is
// worse than either honest alternative, because the prose lends borrowed
// authority to a lookup table.
//
// The state is stored beside each run instead, exactly as the existing mechanical
// stoplight is. Agreement between the two is a confidence signal. Divergence
// flags the run for review, and is informative in both directions: the analyst
// may have seen something the 2x2 cannot encode, or it may have talked itself
// past the numbers. Neither is knowable if the state was never computed, and
// neither is testable if the analyst was shown it first.

import {
  ATTRIBUTION_AXIS_Z, REABSORPTION_AXIS_LINE, ATTRIBUTION_SUSTAIN_MONTHS,
  BASELINE_START, BASELINE_END,
} from "../config.mjs";
// The dependency points THIS way on purpose: the state module reads the payload's
// axes, and payload.mjs imports nothing from here. That is what keeps the state
// out of the model's request — it is a structural guarantee rather than a
// discipline someone has to remember when adding a field.
import { attributionAxisOriented, reabsorptionAxisOriented, fixedBaselineZ } from "../payload.mjs";

export const PAIRED_STATES = {
  REALLOCATION: {
    plain: "Jobs are moving, not disappearing",
    reading: "AI-exposed work is diverging from the rest of the economy, and the " +
      "aggregate labour market is absorbing the outflow.",
  },
  DISPLACEMENT: {
    plain: "Jobs are going away",
    reading: "AI-exposed work is diverging AND the aggregate is deteriorating, so " +
      "the outflow is not landing.",
  },
  NOT_AI: {
    plain: "A general slowdown, not an AI one",
    reading: "The aggregate is deteriorating without an established AI-exposed " +
      "divergence, which is what an ordinary downturn looks like. This also covers a " +
      "gap that has just gone wide and not yet held for three readings: an unconfirmed " +
      "divergence is not yet a reason to call a weak aggregate AI-shaped.",
  },
  STABLE: {
    plain: "Neither signal is moving",
    reading: "No established AI-exposed divergence and no aggregate deterioration.",
  },
  INDETERMINATE: {
    plain: "Not enough clean history to place this",
    reading: "At least one axis has no usable pre-2020 baseline, so the pairing " +
      "cannot be computed. This is not a reading of zero.",
  },
};

/**
 * Place one axis against ITS OWN line.
 *
 * The two axes are different kinds of quantity and no longer share a threshold.
 * Attribution is a differential between two industry groups, so a z against its
 * own fixed baseline is the right scale. Reabsorption is an economy-wide
 * employment LEVEL, measured in points below a fixed reference year. Forcing both
 * onto one z read tidily and hid the difference.
 *
 * Both are deterioration-positive, so higher always means further toward
 * displacement. null means the axis could not be placed, which is NOT the same as
 * flat and must never collapse into it.
 */
function axisMoving(value, line) {
  if (value == null) return null;
  return value >= line;
}

/**
 * The paired state.
 *
 * @param {number|null} attributionZ deterioration-oriented fixed-baseline z of the
 *   exposed-minus-control jobs differential (gap widening = positive)
 * @param {number|null} reabsorptionFalling the 12-month FALL in the prime-age
 *   (25-54) employment-population ratio, deterioration-positive. Compared against
 *   raw zero: falling at all counts. No baseline, no reference year, no threshold.
 * @param {boolean|null} attributionHeld whether the gap has been at or past its line
 *   for ATTRIBUTION_SUSTAIN_MONTHS consecutive readings ending at this one. null
 *   means there is not enough history to say, which is not the same as false.
 *   Defaults to the value of the single-month test, so a caller that has no history
 *   to hand gets the pre-2026-07-28 behaviour rather than a silent downgrade.
 */
export function pairedState(attributionZ, reabsorptionFalling, attributionHeld = undefined) {
  const wide = axisMoving(attributionZ, ATTRIBUTION_AXIS_Z);
  const deteriorating = axisMoving(reabsorptionFalling, REABSORPTION_AXIS_LINE);
  // THE GAP HAS TO HOLD, NOT MERELY BE WIDE. See ATTRIBUTION_SUSTAIN_MONTHS: a
  // single month past the line used to establish this axis, the gap has been past
  // the line since 2023, and the consequence was that the AI-specific axis never
  // changed the quadrant while the economy-wide one changed it eight times in
  // eighteen months. Held is what the right-hand quadrants now require.
  const held = attributionHeld === undefined ? wide : attributionHeld;

  // An unplaceable axis is reported as such. Guessing here would be the same
  // error as scoring against a truncated baseline: a confident answer resting on
  // history that does not exist.
  const state = held == null || deteriorating == null
    ? "INDETERMINATE"
    : held
      ? (deteriorating ? "DISPLACEMENT" : "REALLOCATION")
      : (deteriorating ? "NOT_AI" : "STABLE");

  return {
    state,
    plain: PAIRED_STATES[state].plain,
    reading: PAIRED_STATES[state].reading,
    attribution: {
      z: attributionZ == null ? null : Math.round(attributionZ * 100) / 100,
      moving: held,
      // Reported separately from [moving] on purpose: a month where the gap is wide
      // but has not yet held is a real and readable condition, and collapsing it
      // into "gap flat" would describe a wide gap as a narrow one.
      wideThisMonth: wide,
      heldForMonths: ATTRIBUTION_SUSTAIN_MONTHS,
      label: held == null ? "cannot be placed"
        : held ? "gap wide and holding"
          : wide ? `gap wide but not yet held for ${ATTRIBUTION_SUSTAIN_MONTHS} readings`
            : "gap flat",
    },
    reabsorption: {
      employmentFalling: reabsorptionFalling == null ? null : Math.round(reabsorptionFalling * 100) / 100,
      moving: deteriorating,
      label: deteriorating == null ? "cannot be placed" : deteriorating ? "aggregate deteriorating" : "aggregate holding",
    },
    attributionLineZ: ATTRIBUTION_AXIS_Z,
    attributionSustainMonths: ATTRIBUTION_SUSTAIN_MONTHS,
    reabsorptionLine: REABSORPTION_AXIS_LINE,
    definitions: {
      widening: `the exposed-minus-control job-growth gap is at least ${ATTRIBUTION_AXIS_Z} standard ` +
        `deviation further below its ${BASELINE_START}..${BASELINE_END} average, that window fixed and never rolling, ` +
        `AND has been for ${ATTRIBUTION_SUSTAIN_MONTHS} consecutive readings. The run requirement is the ` +
        `newer half and it is what stops the vertical axis deciding this grid on its own: ` +
        `one month past the line used to establish this axis, the gap has been past the ` +
        `line since 2023, and the result was that the only thing ever changing the quadrant ` +
        `was an economy-wide employment change that an ordinary recession moves`,
      deteriorating: `the prime-age (25-54) employment-population ratio is LOWER than ` +
        `it was twelve months ago. A change against raw zero, with no baseline, no ` +
        `reference year and no threshold, because those were all the wrong kind of ` +
        `answer here: a level against 2019 anchored the boundary to a cyclical peak ` +
        `and would have read displacement across most of the 2010s, and z-scoring the ` +
        `change against 2010-2019 scored a mature expansion against a decade of ` +
        `recovery. Zero involves no distribution, so nothing can contaminate it.`,
    },
    // Both lines sit at zero because the grid is a DISPLAY, not a trigger. One
    // month in a bad quadrant is a data point; whether it is a trend or a single
    // noisy print is the analyst's call. The trigger lives in the stoplight.
    lineRationale:
      "Both axes cross at zero, and zero is a fact about each measure rather than a " +
      "chosen threshold: the gap sitting at its own 2010s norm, and employment flat " +
      "year-over-year. Validated before adoption — this never calls the 2014-2019 " +
      "boom displacement.",
  };
}

/**
 * The 2x2 path: the last [months] readings placed as states, so movement between
 * quadrants is visible rather than a single marker. Both series are walked on the
 * attribution panel's months, and a month missing either axis is dropped rather
 * than carried forward — a fabricated point on a path chart reads as a real
 * transition.
 */
export function pairedPath(attributionOriented, reabsorptionShortfall, zOf, months = 24) {
  const reab = new Map(reabsorptionShortfall);

  // Every attribution month is scored FIRST, before anything is dropped, because the
  // run of wide readings is a fact about the attribution series and not about which
  // months happen to have a reabsorption partner. Computing it after the filter would
  // let a missing employment print (October 2025 is one) silently break a run that
  // never broke, and the run is now what promotes the right-hand quadrants.
  const zs = [];
  for (let i = 0; i < attributionOriented.length; i++) {
    // Z-scored against history up to and including this month, so a past point is
    // placed with the information available then rather than with hindsight.
    zs.push(zOf(attributionOriented.slice(0, i + 1)));
  }

  /** Has the gap been at or past its line for the whole run ending at [i]? */
  const heldAt = (i) => {
    if (i + 1 < ATTRIBUTION_SUSTAIN_MONTHS) return null; // not enough history to say
    for (let k = i; k > i - ATTRIBUTION_SUSTAIN_MONTHS; k--) {
      const m = axisMoving(zs[k], ATTRIBUTION_AXIS_Z);
      if (m == null) return null;   // an unplaceable month breaks the claim, not the run
      if (!m) return false;
    }
    return true;
  };

  const out = [];
  for (let i = 0; i < attributionOriented.length; i++) {
    const m = attributionOriented[i][0];
    if (!reab.has(m)) continue;
    // Reabsorption is already a change in points against zero, so it needs no
    // scoring — it is read straight off.
    out.push({ month: m, ...pairedState(zs[i], reab.get(m), heldAt(i)) });
  }
  return out.slice(-months);
}

/** The current state plus the trailing 24-month path, straight off the pool. */
export function pairedStateFromPool(pool, months = 24) {
  const attribution = attributionAxisOriented(pool);
  const reabsorption = reabsorptionAxisOriented(pool);
  const latestShortfall = reabsorption.length ? reabsorption[reabsorption.length - 1][1] : null;

  // The run of wide readings ending at the latest attribution month. Read off the
  // attribution series directly rather than off the path, which drops months missing
  // a reabsorption partner and would therefore report a shorter run than the gap
  // actually had.
  const heldNow = (() => {
    if (attribution.length < ATTRIBUTION_SUSTAIN_MONTHS) return null;
    for (let i = attribution.length - 1; i > attribution.length - 1 - ATTRIBUTION_SUSTAIN_MONTHS; i--) {
      const z = fixedBaselineZ(attribution.slice(0, i + 1));
      const m = axisMoving(z, ATTRIBUTION_AXIS_Z);
      if (m == null) return null;
      if (!m) return false;
    }
    return true;
  })();

  const current = pairedState(fixedBaselineZ(attribution), latestShortfall, heldNow);
  return {
    ...current,
    path: pairedPath(attribution, reabsorption, fixedBaselineZ, months),
  };
}
