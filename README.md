# ai-labor-dashboard-data

Central data pool for the **AILaborDashboard** Android app. Three GitHub Actions
jobs refresh `dashboard-data.json` weekly; every installed copy of the app reads
that one file (raw URL) instead of calling any external API itself. The shipped
app contains **no API keys** and makes **no direct external API calls**.

```
raw file consumed by the app:
https://raw.githubusercontent.com/DoubleJ0n/ai-labor-dashboard-data/main/dashboard-data.json
```

## Refresh pipeline

| Job | Script | Model / API | Schedule (UTC) | Writes section |
|---|---|---|---|---|
| fred-refresh | `scripts/fred-refresh.mjs` | FRED API (free) | Mon 06:00 | `fred` |
| discovery-refresh | `scripts/discovery-refresh.mjs` | Claude Haiku 4.5 (`claude-haiku-4-5-20251001`) + web search | Mon 06:20 | `capability` |
| analysis-refresh | `scripts/analysis-refresh.mjs` | Claude Sonnet 5 (`claude-sonnet-5`) | Mon 06:50 (after the other two) | `analysis` |

Rules all three follow:

- **Last-write-wins per section.** Each script re-reads `dashboard-data.json`,
  replaces only its own top-level section, and never touches the others.
- **Weekly cron + `workflow_dispatch`** manual trigger on each.
- Keys come only from Actions secrets `FRED_API_KEY` / `ANTHROPIC_API_KEY`;
  nothing secret is ever committed.
- analysis-refresh only calls the model when the FRED/capability inputs have
  meaningfully changed since the last analysis (`analysis.inputsFingerprint`);
  otherwise it keeps the prior text and bumps the timestamp.

## Schema: `dashboard-data.json`

The JSON mirrors the app's existing data models (`ObservationEntity`,
`CapabilityPointEntity`, `BenchmarkSlotEntity`, `AnalysisEntity`) — the JSON
conforms to what the charts already consume, not the reverse. All timestamps
are ISO-8601 UTC. Each top-level section carries its own `lastRefreshed`.

```jsonc
{
  "schemaVersion": 1,

  // Raw FRED observations, last 10 years, per series id. The app computes
  // ALL derived metrics (GDP-vs-employment, productivity band, indexed
  // sectors, recent-grad inversion, Displacement Watch z-scores) on-device
  // from these — so these series ARE the Displacement Watch inputs.
  "fred": {
    "lastRefreshed": "2026-07-11T06:00:00Z", // null until first run
    "series": {
      // series ids consumed by the app (domain/Models.kt SeriesIds.ALL):
      // GDPC1 (real GDP, quarterly), PAYEMS (payrolls), USINFO (information
      // sector), TEMPHELPS (temp help), CES6054150001 (internet publishing),
      // CGBD2024 (recent-grad unemployment 20-24), LNS14000036 (young
      // unemployment), UNRATE (general unemployment)
      "GDPC1":  [ { "date": "2016-07-01", "value": 18324.312 } /* ... */ ],
      "PAYEMS": [ /* ... */ ]
      // one array per series id, ascending by date
    }
  },

  // Capability data: METR task-length horizons + normalized benchmark
  // tracks. Mirrors CapabilityPointEntity / BenchmarkSlotEntity 1:1.
  "capability": {
    "lastRefreshed": "2026-07-11T06:20:00Z",
    "points": [
      {
        "metricId": "metr",          // "metr" | "normalized"
        "seriesKey": "p50",          // metr: "p50"|"p80"; normalized: "reasoning"|"coding"|"biology"
        "pointDate": "2025-08-07",   // model release / result date
        "label": "GPT-5",            // model name (normalized: "model (benchmark)")
        "value": 137.0,              // metr: minutes; normalized: 0-100 score
        "sourceUrl": "https://metr.org/...",
        "fetchDate": "2026-07-11"    // when this number was fetched/verified
      }
    ],
    "slots": [
      {
        "slot": "reasoning",         // "reasoning" | "coding" | "biology"
        "benchmarkName": "FrontierMath",
        "sourceUrl": "https://epoch.ai/frontiermath",
        "fetchDate": "2026-07-11",
        "saturated": false,
        "note": "one plain-language sentence describing the benchmark"
      }
    ],
    // append-only run log (latest first, capped at 20) mirroring the app's
    // enrichment_log table
    "log": [
      { "runDate": "2026-07-11", "foundNew": false, "summary": "nothing new found" }
    ]
  },

  // Synthesized plain-language read of the whole dashboard. Written ONLY by
  // analysis-refresh (Sonnet 5), reasoning ONLY from the numbers in this
  // file. Mirrors AnalysisEntity.
  "analysis": {
    "lastRefreshed": "2026-07-11T06:50:00Z",
    "text": "…a few hundred plain-language words… REGIME SIGNAL: AMBIGUOUS",
    "signal": "AMBIGUOUS",           // NONE | AMBIGUOUS | PARTIAL | FIRING | UNKNOWN
    "model": "claude-sonnet-5",
    "inputTokens": 0,
    "outputTokens": 0,
    "estimatedCostUsd": 0.0,
    // sha256 of the rounded metric inputs the analysis saw; used to skip the
    // model call when nothing meaningful changed
    "inputsFingerprint": "e3b0c442..."
  }
}
```

## Manual refresh

```
gh workflow run fred-refresh.yml
gh workflow run discovery-refresh.yml
gh workflow run analysis-refresh.yml
```
