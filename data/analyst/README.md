# Analyst dissent log (`dissent_log.json`)

Append-only record of the monthly Analyst verdict. `analyst-refresh` appends
exactly one entry per BLS Employment Situation release and never rewrites a prior
entry. It is the data source for the app's **Analyst Track Record** timeline, and
each run receives the prior log so it can score whether last month's named
confounder held up.

## Entry shape

```jsonc
{
  "date": "2026-07",                 // the DATA month the verdict describes (YYYY-MM)
  "runAt": "2026-08-07T13:05:00Z",   // when the analyst run produced it (ISO 8601)
  "verdict": "MIXED_TRANSITIONING",  // one of the four fixed enums (see below)
  "tagLine": "temp help fell again", // ~4 words for directional verdicts; a full
                                     //   sentence for CONFOUNDED (it names the mechanism)
  "confoundedPathway": null,         // null unless verdict==CONFOUNDED; then one of
                                     //   "recession_veto" | "data_integrity" | "analyst_veto"
  "namedConfounder": null,           // required (non-null) when verdict==CONFOUNDED;
                                     //   a SPECIFIC mechanism tied to THIS month's movement
  "mechanicalState": "WATCH",        // the stoplight state (STEADY|WATCH|BREAK) the SAME
                                     //   inputs produced — lets next month note agree/disagree
  "breadth": 1,                      // # of confounder-robust labor differentials firing (0..3)
  "analysis": "..."                  // the plain-text paragraph(s) the model wrote
}
```

## The four verdicts (fixed — no additions, no free-form)

1. `AUGMENTATION_HOLDING` — gains visible, exposed jobs/wages not deteriorating.
2. `MIXED_TRANSITIONING` — signals moving but not decisively either way.
3. `DISPLACEMENT_EMERGING` — displacement signals firing, augmentation not showing up.
4. `CONFOUNDED` — a specific named confounder dominates this month's data.

The first three are **directional**. `CONFOUNDED` is reached three ways, two
deterministic (`recession_veto`, `data_integrity`) and one via the model
(`analyst_veto`, DOWNGRADE-ONLY — news may never produce or strengthen a
directional verdict; it may only, through this logged pathway, downgrade to
CONFOUNDED). Derivation lives in `scripts/analyst/verdict.mjs`.

## Timeline ordinal (for the track-record chart)

`AUGMENTATION_HOLDING` low · `MIXED_TRANSITIONING` middle · `DISPLACEMENT_EMERGING`
high. `CONFOUNDED` does **not** plot on the stepped line — it drops to a flagged
x-axis marker so a punting streak reads as its own pattern.
