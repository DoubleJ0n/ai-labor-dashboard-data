// Designed with Claude (Anthropic)
//
// Falsifier resolution — scoring the predictions the analyst has been making.
//
// WHY THIS EXISTS. Every run since the two-pass rewrite has pre-registered what
// would overturn its reading, and until now nothing ever checked whether the
// predicted thing happened. The falsifier was stored, shown to the next run's
// pass 2, and critiqued for how it was CONSTRUCTED — but no code asked whether it
// FIRED. Pre-registration without resolution is ceremony: it produces the
// appearance of accountability and none of the substance, and it is worse than
// nothing because it looks like a track record from the outside.
//
// WHAT A RESOLUTION IS. Four outcomes, and the distinctions matter:
//
//   FIRED         the condition was met. The reading it was attached to was wrong,
//                 and that is the point of having said so in advance.
//   NOT_FIRED     the horizon passed and the condition was not met. Weak evidence
//                 FOR the reading — weak because most falsifiers are set at levels
//                 that rarely trip, so not firing is the expected case.
//   NOT_YET_DUE   the horizon has not passed. Not a result.
//   UNCHECKABLE   the panel or field is gone, or the falsifier was never scorable.
//                 Recorded loudly rather than quietly dropped, because a run of
//                 UNCHECKABLE outcomes means the instrument is broken, not that
//                 the analyst is doing well.
//
// NOT_FIRED IS NOT A WIN. A falsifier set where nothing could reach it produces
// NOT_FIRED forever and says nothing about whether the reading was any good. The
// resolution record therefore carries the distance travelled toward the threshold,
// so a reader can tell "nowhere near it" from "just missed it" — those are very
// different pieces of evidence about the same NOT_FIRED.

/** Pull a numeric field off a panel by name, tolerating nesting one level deep. */
export function readPanelField(panels, panelName, field) {
  const p = panels.find((x) => x.panel === panelName);
  if (!p) return { ok: false, why: `panel "${panelName}" is not in the current payload` };
  if (Object.prototype.hasOwnProperty.call(p, field)) {
    const v = p[field];
    if (typeof v === "number") return { ok: true, value: v };
    return { ok: false, why: `field "${field}" on "${panelName}" is not a number` };
  }
  // One level of nesting, so a falsifier can name a field inside headline or
  // deviation_from_normal without needing dotted-path support.
  for (const [k, v] of Object.entries(p)) {
    if (v && typeof v === "object" && !Array.isArray(v) && typeof v[field] === "number") {
      return { ok: true, value: v[field], via: k };
    }
  }
  return { ok: false, why: `field "${field}" not found on panel "${panelName}"` };
}

const meets = (value, comparator, threshold) =>
  comparator === "at_or_below" ? value <= threshold : value >= threshold;

/**
 * Resolve ONE falsifier against the current panels.
 *
 * [asOfIso] is the run date. A falsifier fires the moment its condition is met,
 * whether or not the horizon has expired — being right early still counts — but it
 * cannot be declared NOT_FIRED until the horizon has passed.
 */
export function resolveFalsifier(falsifier, panels, asOfIso) {
  if (!falsifier || falsifier.scorable === false || !falsifier.panel || !falsifier.field) {
    return {
      outcome: "UNCHECKABLE",
      reason: falsifier?.unscorableReason
        ?? "no structured condition was recorded for this run",
    };
  }

  const conditions = [
    { role: "primary", ...falsifier },
    ...(falsifier.also ? [{ role: "secondary", ...falsifier.also }] : []),
  ];

  const evaluated = [];
  for (const c of conditions) {
    const read = readPanelField(panels, c.panel, c.field);
    if (!read.ok) return { outcome: "UNCHECKABLE", reason: read.why };
    evaluated.push({
      role: c.role,
      panel: c.panel,
      field: c.field,
      comparator: c.comparator,
      threshold: c.value,
      observed: read.value,
      met: meets(read.value, c.comparator, c.value),
      // Signed distance to the threshold, so NOT_FIRED can be read as "nowhere
      // near" or "just missed" instead of collapsing both into one word.
      distanceToThreshold: Math.round((c.value - read.value) * 100) / 100,
    });
  }

  const allMet = evaluated.every((e) => e.met);
  const due = falsifier.by != null && String(asOfIso).slice(0, 10) >= String(falsifier.by).slice(0, 10);

  if (allMet) {
    return {
      outcome: "FIRED",
      reason: `every condition was met${due ? "" : ", ahead of the horizon"}`,
      conditions: evaluated,
    };
  }
  if (!due) {
    return {
      outcome: "NOT_YET_DUE",
      reason: `horizon runs to ${falsifier.by}`,
      conditions: evaluated,
    };
  }
  return {
    outcome: "NOT_FIRED",
    reason: "the horizon passed without every condition being met",
    // Stated so a NOT_FIRED is never read as a stronger result than it is.
    weight: "Weak evidence for the reading this was attached to. Most falsifiers sit " +
      "at levels rarely reached, so not firing is the expected outcome; read the " +
      "distances below before treating it as confirmation.",
    conditions: evaluated,
  };
}

/**
 * Resolve every prior run's falsifier that has not already been settled, and
 * summarise the record.
 *
 * [runs] is runs.json's array, oldest first. Returns both the newly-settled
 * resolutions and a standing tally, which is what pass 2 is shown so the analyst
 * can see its own history rather than being told it has one.
 */
export function resolveOutstanding(runs, panels, asOfIso) {
  const resolutions = [];
  for (const r of runs) {
    // Already settled in an earlier run; do not re-litigate a closed prediction.
    if (r.falsifierResolution && ["FIRED", "NOT_FIRED", "UNCHECKABLE"].includes(r.falsifierResolution.outcome)) {
      resolutions.push({ runAt: r.runAt, dataMonth: r.dataMonth, verdict: r.verdict, ...r.falsifierResolution });
      continue;
    }
    const res = resolveFalsifier(r.falsifier, panels, asOfIso);
    resolutions.push({ runAt: r.runAt, dataMonth: r.dataMonth, verdict: r.verdict, ...res });
  }

  const tally = { FIRED: 0, NOT_FIRED: 0, NOT_YET_DUE: 0, UNCHECKABLE: 0 };
  for (const r of resolutions) tally[r.outcome] = (tally[r.outcome] ?? 0) + 1;

  const settled = tally.FIRED + tally.NOT_FIRED;
  return {
    resolutions,
    tally,
    // The honest summary. Note what it refuses to say: with a handful of runs and
    // most of them unsettled, there is no track record yet, and claiming one would
    // be the same error as the falsifier that was never checked.
    summary: settled === 0
      ? `No falsifier has yet reached its horizon, so there is no track record to report. ` +
        `${tally.NOT_YET_DUE} still running, ${tally.UNCHECKABLE} unscorable.`
      : `${tally.FIRED} of ${settled} settled falsifiers fired. ` +
        `${tally.NOT_YET_DUE} still running, ${tally.UNCHECKABLE} unscorable. ` +
        (settled < 5
          ? "Too few settled predictions to mean anything yet; this is a record being started, not a score."
          : "Read a high not-fired rate with suspicion: it may mean the readings were right, or it may mean the thresholds were set out of reach."),
  };
}
