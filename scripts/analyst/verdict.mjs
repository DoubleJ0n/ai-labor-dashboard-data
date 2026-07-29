// Designed with Claude (Anthropic)
//
// Analyst verdict derivation — the mechanical half of the monthly Analyst.
//
// This is a faithful port of the app's on-device logic so the Analyst verdict is
// derived from THE SAME panel state and thresholds that drive the stoplight
// (Watch.kt computeDisplacementWatch + Verdicts.kt computeDisplacementChain). The
// model never chooses the verdict; it receives the DERIVED verdict and writes the
// tag line + analysis around it.
//
// FAILURE MODE #4 (the narrow true rule): news may never produce or strengthen a
// directional verdict; it may only, through the logged analyst-veto pathway,
// DOWNGRADE to CONFOUNDED. That veto is applied AFTER this module, in the model
// step — deriveVerdict() only produces the deterministic verdict plus the ONE
// remaining deterministic CONFOUNDED pathway, data_integrity.
//
// The recession_veto pathway is GONE (2026-07-29). See chainState for the argument;
// the short version is that it assumed the recession must be the confounder, and if
// AI-driven labour weakness is itself part of what tips the economy into one, the
// veto fires hardest exactly when the signal is real. The macro reading is still
// computed, still displayed and still sent to the analyst. It no longer decides.

// Thresholds — registered once in config.mjs (audit-2026-07 finding 6);
// re-exported here for existing importers. Pre-registered, do-not-move.
import { CHAIN_BREADTH_MIN, PROD_BAND_LOW, PROD_BAND_HIGH } from "../config.mjs";
export { WATCH_Z, BREAK_Z, PROD_BAND_LOW, PROD_BAND_HIGH } from "../config.mjs";

export const VERDICTS = {
  AUGMENTATION_HOLDING: { ordinal: 0, directional: true },
  MIXED_TRANSITIONING: { ordinal: 1, directional: true },
  DISPLACEMENT_EMERGING: { ordinal: 2, directional: true },
  CONFOUNDED: { ordinal: null, directional: false }, // off-axis on the timeline
};

// The directional set, derived from VERDICTS (was re-declared inline in
// analysis-refresh.mjs — audit-2026-07 finding 9).
export const DIRECTIONAL = new Set(
  Object.entries(VERDICTS).filter(([, v]) => v.directional).map(([k]) => k),
);

/**
 * Port of computeDisplacementChain's verdict: the mechanical stoplight state.
 *
 * THE RECESSION VETO IS REMOVED (2026-07-29), catching this file up with the app,
 * which dropped it on 2026-07-27, and with registered-values.json, which has recorded
 * it as retired since the same date. The pipeline was the last place still doing it.
 *
 * Two reasons, and the second is the one that decided it. First, the veto contradicted
 * a rule the analyst is given in the same payload: the curve is forward-looking, it
 * prices expected conditions rather than realised ones, so it cannot exculpate weakness
 * already sitting in the data. The chain was doing exactly what the analyst is
 * forbidden to do.
 *
 * Second, and worse: the veto assumes the recession is the confounder. If AI-driven
 * labour weakness is itself large enough to help TIP the economy into recession, an
 * inverted curve is downstream of the thing being measured, and vetoing on it
 * suppresses the signal at the moment it matters most. The veto would be most active
 * in precisely the scenario the dashboard exists to catch.
 *
 * The macro reading is still computed, still shown as Link 4, and still sent to the
 * analyst, where weighing cyclical against AI-shaped across several panels at once is
 * a judgement rather than a boolean. What is gone is its power to silently downgrade a
 * mechanical verdict before anyone reasons about it.
 *
 * THE ADOPTION GATE IS ALSO REMOVED (2026-07-29), catching this file up with the app,
 * which dropped it on 2026-07-27. It required firms to report rising AI use before the
 * chain could reach BREAK, and it has to go for two reasons.
 *
 * It does no work. It was written when firm-level AI use was near zero and "you cannot
 * call it AI displacement with no deployment" was a live constraint. Roughly a fifth of
 * firms now report using AI, so the gate is permanently open and can only ever be
 * tripped by the survey breaking. A condition that cannot fail is not a safeguard; it
 * implies a check nobody is performing.
 *
 * And it is the wrong shape for the timing, which is the reason that decides it.
 * Adoption is a lagging, quarterly, self-reported survey of whether firms say they use
 * AI at all. Displacement does not wait for the average firm: it appears as soon as
 * capability covers the work that today's adopters already do, and it would show up in
 * monthly employment data long before a survey of firm-level uptake moved. Gating a
 * fast signal behind a slow one delays exactly the warning this exists to give.
 *
 * Adoption stays computed, stays on the dashboard, and stays in the analyst's payload
 * with a DEPLOYMENT_GATE role saying it can permit a reading and never cause one. What
 * it no longer does is hold a verdict down.
 *
 * @param {("steady"|"watch"|"break")[]} laborVoteStates the confounder-robust
 *   differentials that vote (exposed-vs-control jobs and wages)
 * @param {boolean} capabilityOpen METR shows measured task horizons (permissive gate)
 * @returns {{ state: "STEADY"|"WATCH"|"BREAK", breadth: number }}
 */
export function chainState({ laborVoteStates, capabilityOpen }) {
  const breadth = laborVoteStates.filter((s) => s && s !== "steady").length;
  let state;
  if (breadth === 0) state = "STEADY";
  else if (breadth >= CHAIN_BREADTH_MIN && capabilityOpen) state = "BREAK";
  else state = "WATCH"; // one signal firing
  return { state, breadth };
}

/**
 * The augmentation side of the ledger must show up affirmatively (user-pinned
 * definition): aggregate labor productivity in the [2.7, 3.4) window (above its
 * long baseline, below the displacement tripwire) AND task-level AI use leaning
 * toward complement over substitute (AEI augmentation >= automation).
 */
export function gainsVisible({ productivityYoY, aei }) {
  const prodOk =
    productivityYoY != null && productivityYoY >= PROD_BAND_LOW && productivityYoY < PROD_BAND_HIGH;
  const aeiOk = aei != null && aei.augmentPct != null && aei.automatePct != null &&
    aei.augmentPct >= aei.automatePct;
  return prodOk && aeiOk;
}

/**
 * Derive the deterministic monthly verdict from panel state.
 *
 * @param {object} inputs
 * @param {("steady"|"watch"|"break")[]} inputs.laborVoteStates
 * @param {boolean} inputs.recessionVeto RECORDED, NEVER DECIDING. Kept in factors so
 *   the run log still shows what the bond market was saying at the time; it has had no
 *   effect on the verdict since 2026-07-29.
 * @param {boolean} inputs.capabilityOpen
 * @param {boolean} inputs.adoptionRising RECORDED, NEVER GATING. Kept in factors so the
 *   run log still shows what deployment was doing; it has not held a verdict down since
 *   2026-07-29.
 * @param {number|null} inputs.productivityYoY  latest output-per-hour YoY %
 * @param {{augmentPct:number, automatePct:number}|null} inputs.aei
 * @param {{ok:boolean, reason:(string|null)}} inputs.dataIntegrity  ok=false when the
 *   month's BLS inputs are shifted/incomplete/heavily-revised (pathway b)
 * @returns {{
 *   verdict: string, mechanicalState: string, breadth: number,
 *   confoundedPathway: (string|null), namedConfounder: (string|null),
 *   gainsVisible: boolean, factors: object
 * }}
 */
export function deriveVerdict(inputs) {
  const {
    laborVoteStates, recessionVeto, capabilityOpen, adoptionRising,
    productivityYoY, aei, dataIntegrity = { ok: true, reason: null },
  } = inputs;

  const { state: mechanicalState, breadth } = chainState({ laborVoteStates, capabilityOpen });
  const gains = gainsVisible({ productivityYoY, aei });

  let verdict;
  let confoundedPathway = null;
  let namedConfounder = null;

  if (!dataIntegrity.ok) {
    // Pathway (b): the inputs themselves are unstable this month.
    verdict = "CONFOUNDED";
    confoundedPathway = "data_integrity";
    namedConfounder = dataIntegrity.reason ?? "this month's BLS inputs are shifted, incomplete, or heavily revised";
  } else if (mechanicalState === "BREAK") {
    verdict = "DISPLACEMENT_EMERGING";
  } else if (mechanicalState === "WATCH") {
    verdict = "MIXED_TRANSITIONING";
  } else {
    // STEADY: augmentation only if the gains show up affirmatively; otherwise the
    // fence (quiet-but-not-yet-augmenting is MIXED, not AUGMENTATION_HOLDING).
    verdict = gains ? "AUGMENTATION_HOLDING" : "MIXED_TRANSITIONING";
  }

  return {
    verdict,
    mechanicalState,
    breadth,
    confoundedPathway,
    namedConfounder,
    gainsVisible: gains,
    factors: {
      laborVoteStates, recessionVeto, capabilityOpen, adoptionRising,
      productivityYoY, aei, dataIntegrity,
    },
  };
}
