// Designed with Claude (Anthropic)
//
// The FIXED analyst news allowlist (user-authored, 2026-07-17). Additions require
// a config PR — the analyst never receives an ad-hoc source. Package material is
// CONTEXT and veto raw material ONLY; any veto must trace to something in this
// month's package or to the BLS release itself (no outside knowledge, no recalled
// events). A failed fetch is logged and the run proceeds; a missing source is
// never grounds to skip the monthly run.
//
// Fetch mechanics were verified before wiring (do not invent endpoints):
//  - BLS release is WAF-blocked to automation, but every element the allowlist
//    names (payrolls, unemployment, revisions) is numeric and already in the pool
//    via FRED, so BLS ground truth is sourced FROM THE POOL, not by scraping.
//  - AP has no RSS; its hub renders article links server-side -> best-effort scrape.
//  - NY Fed Liberty Street exposes a clean RSS feed; Atlanta Fed macroblog RSS
//    responds but is sparse -> optional-per-month.

export const ALLOWLIST = [
  {
    id: "bls_employment_situation",
    role: "ground_truth",
    label: "BLS Employment Situation",
    mechanism: "pool", // sourced from the pool's FRED numbers, not a bls.gov fetch
    note: "The factual anchor: headline payrolls, unemployment rate, and prior-month revisions.",
  },
  {
    id: "ap_jobs_report",
    role: "texture",
    label: "AP wire — monthly jobs report",
    mechanism: "scrape",
    url: "https://apnews.com/hub/economy",
    note: "Fast, flat reporting on the print; also the most likely place a same-month real-economy event surfaces in time.",
  },
  {
    id: "fed_liberty_street",
    role: "confounder_depth",
    label: "NY Fed Liberty Street Economics",
    mechanism: "rss",
    url: "https://libertystreeteconomics.newyorkfed.org/feed/",
    optional: true,
    note: "Where benchmark revisions, participation quirks, and census/strike distortions get explained properly.",
  },
  {
    id: "fed_atlanta_macroblog",
    role: "confounder_depth",
    label: "Atlanta Fed macroblog",
    mechanism: "rss",
    url: "https://www.atlantafed.org/rss/macroblog",
    optional: true,
    note: "Second Fed regional research feed; sparse, treated as optional-per-month.",
  },
];

// Jobs-report relevance filter for scraped/RSS material.
export const JOBS_KEYWORDS =
  /\b(jobs?\s+report|employment situation|employment|unemployment|payrolls?|labor market|labour market|hiring|layoffs?|jobless|nonfarm|participation)\b/i;
