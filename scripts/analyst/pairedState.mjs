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
//                     aggregate holding      aggregate deteriorating
//   gap widening      REALLOCATION           DISPLACEMENT
//   gap flat          STABLE                 NOT_AI
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
  ATTRIBUTION_AXIS_Z, REABSORPTION_SHORTFALL_POINTS, REABSORPTION_REFERENCE_YEAR,
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
    reading: "The aggregate is deteriorating without any AI-exposed divergence, " +
      "which is what an ordinary downturn looks like.",
  },
  STABLE: {
    plain: "Neither signal is moving",
    reading: "No AI-exposed divergence and no aggregate deterioration.",
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
 * @param {number|null} reabsorptionShortfall points the prime-age (25-54)
 *   employment-population ratio sits BELOW its reference-year average (falling
 *   behind = positive). A level, not a change — see config for why the change
 *   version was retired.
 */
export function pairedState(attributionZ, reabsorptionShortfall) {
  const widening = axisMoving(attributionZ, ATTRIBUTION_AXIS_Z);
  const deteriorating = axisMoving(reabsorptionShortfall, REABSORPTION_SHORTFALL_POINTS);

  // An unplaceable axis is reported as such. Guessing here would be the same
  // error as scoring against a truncated baseline: a confident answer resting on
  // history that does not exist.
  const state = widening == null || deteriorating == null
    ? "INDETERMINATE"
    : widening
      ? (deteriorating ? "DISPLACEMENT" : "REALLOCATION")
      : (deteriorating ? "NOT_AI" : "STABLE");

  return {
    state,
    plain: PAIRED_STATES[state].plain,
    reading: PAIRED_STATES[state].reading,
    attribution: {
      z: attributionZ == null ? null : Math.round(attributionZ * 100) / 100,
      moving: widening,
      label: widening == null ? "cannot be placed" : widening ? "gap widening" : "gap flat",
    },
    reabsorption: {
      pointsBelowReference: reabsorptionShortfall == null ? null : Math.round(reabsorptionShortfall * 100) / 100,
      moving: deteriorating,
      label: deteriorating == null ? "cannot be placed" : deteriorating ? "aggregate deteriorating" : "aggregate holding",
    },
    attributionLineZ: ATTRIBUTION_AXIS_Z,
    reabsorptionLinePoints: REABSORPTION_SHORTFALL_POINTS,
    definitions: {
      widening: `the exposed-minus-control job-growth gap is at least ${ATTRIBUTION_AXIS_Z} standard ` +
        `deviation further below its ${BASELINE_START}..${BASELINE_END} average, that window fixed and never rolling`,
      deteriorating: `the prime-age (25-54) employment-population ratio is at least ` +
        `${REABSORPTION_SHORTFALL_POINTS} points below its ${REABSORPTION_REFERENCE_YEAR} calendar-year average. A LEVEL, not ` +
        `a change: 2010-2019 is a decade of recovery from the financial crisis, so ` +
        `scoring changes against it made any ordinary expansion year read as ` +
        `deterioration. The cost is that a level is slow to catch a fresh turn, which ` +
        `is why the panel also reports 12-month and 3-month changes.`,
    },
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
  const out = [];
  for (const [m] of attributionOriented) {
    if (!reab.has(m)) continue;
    // Attribution is z-scored against history up to and including this month, so a
    // past point is placed with the information available then rather than with
    // hindsight. Reabsorption is already a shortfall in points against a fixed
    // reference, so it needs no scoring — it is read straight off.
    const aZ = zOf(attributionOriented.filter(([mm]) => mm <= m));
    out.push({ month: m, ...pairedState(aZ, reab.get(m)) });
  }
  return out.slice(-months);
}

/** The current state plus the trailing 24-month path, straight off the pool. */
export function pairedStateFromPool(pool, months = 24) {
  const attribution = attributionAxisOriented(pool);
  const reabsorption = reabsorptionAxisOriented(pool);
  const latestShortfall = reabsorption.length ? reabsorption[reabsorption.length - 1][1] : null;
  const current = pairedState(fixedBaselineZ(attribution), latestShortfall);
  return {
    ...current,
    path: pairedPath(attribution, reabsorption, fixedBaselineZ, months),
  };
}
