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
// step — deriveVerdict() only produces the deterministic verdict + the two
// deterministic CONFOUNDED pathways (recession_veto, data_integrity).

// Thresholds — mirror Watch.kt (WATCH_Z_THRESHOLD / BREAK_Z_THRESHOLD) and the
// productivity calibration band. Pre-registered, do-not-move.
export const WATCH_Z = 1.0;
export const BREAK_Z = 2.0;
export const PROD_BAND_LOW = 2.7; // %/yr — above long baseline
export const PROD_BAND_HIGH = 3.4; // %/yr — the displacement tripwire

export const VERDICTS = {
  AUGMENTATION_HOLDING: { ordinal: 0, directional: true },
  MIXED_TRANSITIONING: { ordinal: 1, directional: true },
  DISPLACEMENT_EMERGING: { ordinal: 2, directional: true },
  CONFOUNDED: { ordinal: null, directional: false }, // off-axis on the timeline
};

/**
 * Port of computeDisplacementChain's verdict: the mechanical stoplight state.
 * @param {("steady"|"watch"|"break")[]} laborVoteStates the three confounder-robust
 *   differentials that vote (exposed-vs-control jobs, wages, postings)
 * @param {boolean} recessionVeto  extended.macro.recessionSignal (inverted curve)
 * @param {boolean} capabilityOpen METR shows measured task horizons (permissive gate)
 * @param {boolean} adoptionRising Type-B deployment gate (hard gate for BREAK)
 * @returns {{ state: "STEADY"|"WATCH"|"BREAK", breadth: number }}
 */
export function chainState({ laborVoteStates, recessionVeto, capabilityOpen, adoptionRising }) {
  const breadth = laborVoteStates.filter((s) => s && s !== "steady").length;
  let state;
  if (breadth === 0) state = "STEADY";
  else if (!adoptionRising) state = "WATCH"; // hard gate: no BREAK without deployment
  else if (breadth >= 2 && capabilityOpen && !recessionVeto) state = "BREAK";
  else state = "WATCH"; // one signal, or a gate/veto holds it back
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
 * @param {boolean} inputs.recessionVeto
 * @param {boolean} inputs.capabilityOpen
 * @param {boolean} inputs.adoptionRising
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

  const { state: mechanicalState, breadth } = chainState({
    laborVoteStates, recessionVeto, capabilityOpen, adoptionRising,
  });
  const gains = gainsVisible({ productivityYoY, aei });

  let verdict;
  let confoundedPathway = null;
  let namedConfounder = null;

  if (!dataIntegrity.ok) {
    // Pathway (b): the inputs themselves are unstable this month.
    verdict = "CONFOUNDED";
    confoundedPathway = "data_integrity";
    namedConfounder = dataIntegrity.reason ?? "this month's BLS inputs are shifted, incomplete, or heavily revised";
  } else if (recessionVeto && breadth >= 1) {
    // Pathway (a): ordinary-recession signal firing WHILE labor signals fire —
    // "AI vs business cycle" is unresolvable in this month's data.
    verdict = "CONFOUNDED";
    confoundedPathway = "recession_veto";
    namedConfounder = "an inverted yield curve is independently pricing an ordinary recession while the labor differentials fire, so exposed-vs-control gaps stop meaning what they normally do";
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
