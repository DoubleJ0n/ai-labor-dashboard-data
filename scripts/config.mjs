// Designed with Claude (Anthropic)
//
// config.mjs — the single registered home of every pre-registered value in
// the data repo (audit-2026-07 findings 5, 6, 7, 9, 21: these values were
// previously re-declared per file, and one live path had drifted).
//
// RULES
// - Every script imports from here; nothing re-declares a value below.
// - These mirror the app's registered constants (Metrics.kt, Watch.kt,
//   Verdicts.kt, Calibration.kt, SeriesIds.kt). config.test.mjs asserts this
//   file against registered-values.json, the cross-repo registration record.
// - Pre-registered, do-not-move: changing any value here is a public
//   re-registration, not maintenance.

// --- Statistical thresholds and windows (mirror Watch.kt) ---
export const WATCH_Z = 1.0; // amber: attention, not alarm
export const BREAK_Z = 2.0; // the one-in-twenty alarm line
export const WATCH_MIN_HISTORY = 36; // readings before a z-score is trustworthy

// --- The baseline window (re-registered 2026-07: FIXED, was rolling) ---
//
// This replaces the rolling TRAILING_WINDOW = 120 that every panel used to
// z-score against. The old window was not merely arbitrary, it was circular: on
// a pool holding exactly 120 monthly readings the "trailing 10-year baseline"
// WAS the entire dataset, and a majority of it sat inside the period the
// dashboard exists to evaluate. Post-treatment data was defining the control,
// so "inside its normal range" partly meant "consistent with the AI era."
//
// A rolling window also chases the trend it is supposed to detect: five years of
// steady deterioration re-centres the mean every month and reads as normal the
// whole way down. A displacement episode would be normalised as it happened.
//
// So the baseline is fixed and pre-treatment, and it never moves:
export const BASELINE_START = "2010-01"; // fixed baseline, never rolling
export const BASELINE_END = "2019-12";
export const OBSERVATION_START = "2023-01"; // what is being measured against it

// The unusable middle. WIDENED from the old COVID window (2020-01..2021-12) by
// twelve months, which is a public re-registration and not maintenance. 2022
// belongs in the hole for a different reason than 2020-21: the pandemic whipsaw
// inflated every standard deviation, while 2021-22 was the exposed-industry
// hiring overshoot whose unwind is the standing non-AI explanation on this
// dashboard. Leaving 2022 in a baseline lets the overshoot peak help define
// "normal", which is the same post-treatment error in a different costume.
export const UNUSABLE_START = "2020-01";
export const UNUSABLE_END = "2022-12";

// ACCEPTANCE IS THE COVERAGE START DATE, NOT THE READING COUNT.
//
// A reading count is the wrong test, and it was quietly permitting the exact thing
// the fixed window exists to prevent. Thirty-six monthly readings is satisfiable by
// 2016-07..2019-12 alone — which is not a neutral decade, it is the late-cycle top
// of one expansion. A baseline drawn from those years scores today against the
// tightest stretch of the last cycle and nothing else. Passing a count check said
// nothing about whether the window was representative.
//
// So a z-scored series must COVER the baseline from BASELINE_START. One that cannot
// is either on the declared exempt list below, with its reason, or it fails the run.
export const BASELINE_REQUIRED_START = BASELINE_START;

// Cadence slack, in months, when testing coverage. Quarterly observations are dated
// at quarter end here, so a quarterly series' first baseline reading is legitimately
// 2010-03 rather than 2010-01. Three months and no more.
export const BASELINE_START_SLACK_MONTHS = 3;

// The fetch must start a YEAR EARLIER than the baseline, and this is the detail that
// made the first cut of the fixed window wrong. Nearly every panel here is DERIVED:
// year-over-year differentials, twelve-month changes, four-quarter changes. A series
// fetched from 2010-01 yields a derived series starting 2011-01, so the baseline
// silently lost its first twelve months to the derivation — and no count check
// noticed, because 108 readings still clears 36. That is the whole argument for
// testing the start date instead.
export const BASELINE_FETCH_START = "2009-01";

// Retained as a SECONDARY floor only. Coverage from BASELINE_START is the acceptance
// test; this catches a series that starts on time but is riddled with holes.
export const BASELINE_MIN_READINGS = WATCH_MIN_HISTORY;

// Panels that CANNOT reach the baseline window and never will, each with its reason,
// because "record the actual start and the reason it can't" has to be a declared
// list rather than a silent fallback. Every FRED series this dashboard z-scores was
// verified in CI (2026-07-26) to begin at or before 2006-03, so for those a missing
// baseline is always a real defect and fails the run. These are the genuine cases:
export const BASELINE_EXEMPT_PANELS = {
  job_postings_spread:
    "Indeed's series begins 2020-02. There is no pre-2020 observation to be had and " +
    "no amount of waiting creates one, so this panel is scored against a window that " +
    "contains the period being judged.",
  ai_adoption:
    "The Census AI question begins 2025-11, and the question wording changed at that " +
    "point, so there is no comparable earlier reading.",
  ai_use_automation_vs_augmentation:
    "One reading per dataset release beginning 2025-09. Not a monthly series, and far " +
    "too short for any baseline.",
};

// --- Productivity band (mirrors Metrics.kt; the 2.7/3.4 registration) ---
export const PROD_BAND_LOW = 2.7; // %/yr — above long baseline
export const PROD_BAND_HIGH = 3.4; // %/yr — the displacement tripwire
export const PROD_BREAK_RUN_QUARTERS = 2; // consecutive quarters above the band for BREAK

// --- Verdict-chain rule parameters (finding 7: previously inline literals) ---
export const CHAIN_BREADTH_MIN = 2; // voting differentials that must fire for BREAK
export const ADOPTION_RISING_LOOKBACK = 4; // readings back for the "rising" deployment gate
export const DATA_INTEGRITY_MAX_STALE_MONTHS = 3; // labor data older than this is unstable inputs

// --- Heavy-revision detection (finding 10: registered with its implementation) ---
// A logged month's jobs/wages differential moving by more than this many
// percentage points on a later re-read of the same reference month means the
// BLS inputs were heavily revised -> deterministic CONFOUNDED (pathway b).
export const HEAVY_REVISION_MAX_PP = 0.5;

// --- Worker share of income, Card 2 (finding 1 re-registration, 2026-07) ---
// Change in the GDICOMP/GDI share over LABOR_SHARE_CHANGE_QUARTERS quarters,
// z-scored against its trailing LABOR_SHARE_BASELINE_QUARTERS history of such
// changes, COVID-excluded, latest reading excluded from the baseline.
export const LABOR_SHARE_CHANGE_QUARTERS = 4;
// LABOR_SHARE_BASELINE_QUARTERS (trailing 30 years) is RETIRED 2026-07-26. Card 2
// now scores its 4-quarter changes against the same fixed 2010-2019 window as
// every other panel. Keeping a constant that promised a rolling thirty-year norm
// while the code used a fixed decade is precisely the drift this file prevents.
// For a quarterly series the fixed window is 40 readings, above the 36 minimum
// but not comfortably, and the payload reports the count so the thinness shows.

// --- Trend-direction parameters (finding 21: previously duplicated inline) ---
export const TREND_DRIFT_Z = 0.3; // z-drift beyond which a streak is moving, not flat
export const TREND_LOOKBACK_READINGS = 4; // readings compared for the drift

// --- GDPval-AA leaderboard (capability context; votes on nothing) ---
// Elo is frozen per index version and versions are NOT comparable (v1 topped by
// Opus 4.8 at 1890, v2 by Opus 5 at 1861). The upstream field name carries the
// version, so gdpval-refresh reads it from the data and fails when it differs
// from this registration — a pool roll is a public re-registration.
export const GDPVAL_POOL_VERSION = "v2";
// Held at 50 deliberately. On 2026-08-24 upstream stopped publishing full records for
// all but the ~30 displayed models, and this threshold is the only thing that stopped a
// 192-model leaderboard being overwritten by 29. Do not lower it to make the job green.
export const GDPVAL_MIN_RECORDS = 50;
export const GDPVAL_REQUIRED_LABS = ["Anthropic", "OpenAI"]; // the per-lab chart needs both

// SANITY BOUNDS ON THE PARSE, which is a different job from bounding Elo itself.
//
// What can actually go wrong here is the regex latching onto the wrong number and
// publishing a leaderboard of percentages, ranks, or release years. The first attempt
// to catch that required every Elo to sit in [100, 3000], which conflated the two: it
// read as a claim about how low an Elo can be, and Elo has no floor. The anchor is
// arbitrary, only differences carry information, and the bottom of the pool sinks as
// weaker models are added to it. The live board already ran from 6.64 to 1860 on the
// day that check was written, so it failed on its first scheduled run and every run
// after, and the panel sat frozen for ten days.
//
// The distribution is the honest discriminator, because the misparses all collapse it:
// a percentage column tops out at 100, a rank column at the record count, a year column
// spans about six. A real Elo pool has a leader far above any of those and spreads over
// a thousand points. So no per-value floor; a ceiling to catch a runaway parse, and two
// shape checks that a wrong column cannot satisfy.
export const GDPVAL_MAX_ELO = 3000;       // above any plausible Elo; catches token counts
export const GDPVAL_MIN_TOP_ELO = 800;    // live leader 1860; a percentage or rank column cannot reach this
export const GDPVAL_MIN_ELO_SPREAD = 500; // live spread 1854; years span ~6, percentages <=100
// 400 Elo = 10:1 odds. The scale constant in the logistic, not a tunable.
export const ELO_SCALE = 400;

// --- Other registered windows ---
export const INVERSION_TRAILING_WINDOW_MONTHS = 120;
export const INVERSION_MIN_HISTORY_MONTHS = 36;
export const SECTOR_PEAK_WINDOW_START = "2021-01-01";

// --- The voting-differential taxonomy (finding 5: was declared three times).
// The identity of the three panels that decide the verdict. The app's
// SeriesIds groups are the acknowledged cross-repo mirror.
export const DIFFERENTIALS = {
  jobs: {
    // CES industry employment (SA, thousands)
    exposed: ["USINFO", "USPBS", "USFIRE"], // information, professional/business, financial
    control: ["USCONS", "USLAH", "USEHS"], // construction, leisure/hospitality, education/health
  },
  wages: {
    // CES average hourly earnings, all employees (SA, $), same industries
    exposed: ["CES5000000003", "CES6000000003", "CES5500000003"],
    control: ["CES2000000003", "CES7000000003", "CES6500000003"],
  },
};

// --- The reabsorption axis (new 2026-07) ---
//
// Why this exists: the exposed-vs-control gap cannot carry a displacement
// verdict, because it measures REALLOCATION. Work the mechanics — if AI
// eliminates 100 jobs in information and professional services and all 100 of
// those workers are hired in construction and health care, exposed employment
// falls, control employment rises, the gap widens from both ends at once, and
// total employment is unchanged with every worker landing somewhere. Perfect
// reallocation produces a maximally negative gap and zero net displacement.
//
// The gap is still necessary: it is the only thing on this dashboard that lets
// anything be attributed to AI-exposed work rather than to the general economy.
// But it is an ATTRIBUTION measure, and attribution is half the question. The
// missing half is whether the outflow landed anywhere, which is what these
// series ask. None of them requires knowing where any individual went.
//
// Every id below was verified against the FRED series endpoint in CI before
// being wired (the standing rule: an unverified series id never gets wired).
// Titles and ranges as returned 2026-07-26.
export const REABSORPTION = {
  // Employment-Population Ratio - 25-54 Yrs. (percent, SA, monthly, 1948-01+).
  // THE HEADLINE. Restricting to 25-54 strips the demographic drift that
  // contaminates the all-ages participation rate: retirements pull the headline
  // down for reasons that have nothing to do with anyone being displaced.
  primeAgeEpop: "LNS12300060",
  // Of Total Unemployed, Percent Unemployed 27 Weeks & over (percent, SA,
  // monthly, 1948-01+). Are exits failing to land.
  longTermUnemployedShare: "LNS13025703",
  // Hires: Total Nonfarm, rate (SA, monthly, 2000-12+). Absorption pace.
  hiresRate: "JTSHIR",
  // Quits: Total Nonfarm, rate (SA, monthly, 2000-12+). Shedding pace.
  quitsRate: "JTSQUR",
  // U-6 minus U-3: landing, but underemployed. UNRATE is already in the pool.
  u6: "U6RATE",
  u3: "UNRATE",
  // Layoffs and Discharges: Total Nonfarm, rate (SA, monthly, 2000-12+).
  //
  // Added 2026-07-28 to separate STRUCTURAL from CYCLICAL, which nothing on the
  // dashboard previously distinguished. Low hires with NORMAL layoffs is a frozen
  // market: firms are not replacing people who leave, and the pain falls on whoever
  // is trying to get in. Low hires with ELEVATED layoffs is an ordinary cycle:
  // firms are shedding. Those are different economies and the reabsorption axis
  // reads the same on both, because a hires-minus-quits spread cannot tell you
  // which side of the ledger moved.
  //
  // Verified against FRED 2026-07-29: "Layoffs and Discharges: Total Nonfarm,
  // Rate, Monthly, Seasonally Adjusted", 2000-12 .. 2026-05.
  layoffsRate: "JTSLDR",
  // The two halves of the headline ratio, so a move can be DECOMPOSED.
  //
  // primeAgeEpop is employed/population, and a ratio can fall two ways: employment
  // drops, or population grows faster than employment does. Those mean opposite
  // things — one is people losing work, the other is a growing working-age
  // population the job market has not caught up with, most often immigration or a
  // large cohort ageing in. With the ratio alone the panel cannot tell them apart,
  // and it now carries a quadrant boundary, so it should.
  //
  // Both verified against the FRED series endpoint in CI 2026-07-27:
  // Employment Level 25-54 and Population Level 25-54, thousands, 1948-01 onward.
  primeAgeEmployed: "LNS12000060",
  primeAgePopulation: "LNU00000060",
};

// HOW THE REABSORPTION AXIS IS PLACED — re-registered 2026-07-27.
//
// It reads the LEVEL of prime-age employment-population against a fixed 2019
// reference, and NOT the z of its 12-month change. The change version was tried
// first and was wrong in a way that only showed up once the real data arrived.
//
// The reasoning for the change version was that a level scored against the
// 2010-2019 MEAN would read as abnormally healthy forever, because that decade
// opens in the post-financial-crisis hole and climbs for ten years. That much was
// right. What it missed is that the same recovery contaminates the CHANGES: prime-
// age employment rose 5.3 points over that decade, about +0.53 a year, so strongly
// positive 12-month changes were structurally normal in the baseline. Scored that
// way, any mature-expansion year reads as deteriorating, and on first real data
// the axis returned 1.77 — most of which was "we stopped recovering from 2008"
// rather than "absorption is failing". That is the mirror image of the flaw it was
// introduced to fix.
//
// A fixed reference LEVEL has neither problem. The comparison is to a specific,
// nameable state of the labour market rather than to the average of a decade spent
// travelling between two very different states.
//
// What it gives up: a level test is slow to notice a fresh turn from a high level.
// So the 12- and 3-month changes are still reported beside it as context. The level
// places the axis; the changes catch the turn; neither is asked to do the other's
// job.
export const REABSORPTION_REFERENCE_YEAR = 2019; // calendar-year mean, pre-pandemic

// How far below the reference counts as the aggregate failing to absorb.
//
// A judgement, registered as one. Prime-age employment-population swung 4.82 points
// between its 2011 trough and its 2019 level, so a full recession is roughly five
// points on this series and one point is about a fifth of that. In people: prime-age
// population is around 130 million, so a one-point shortfall is roughly 1.3 million
// people of prime working age without a job who would have had one in 2019. That is
// a claim a reader can check, which a z-score is not. The raw shortfall is reported
// every run so anyone can apply a different line.
// RETIRED as a threshold 2026-07-27, kept only to describe where the level sits.
// The level-against-2019 test anchored the boundary to a CYCLICAL PEAK, and almost
// every month in history sits below a peak: with the line at zero it would have read
// "jobs are going away" for 100% of 2011-2013 and 76% of 2014-2019. The axis reads
// the 12-month change now; see REABSORPTION_AXIS_LINE.
export const REABSORPTION_SHORTFALL_POINTS = 1.0;

export const REABSORPTION_CHANGE_MONTHS = 12;

// A twelve-month change is the right orientation for PLACING the axis, and it is
// slow: a turn can take a year to show up in it. The three-month change is reported
// beside it as context so a recent inflection is visible before the headline
// registers it. It is CONTEXT AND NOT A SECOND VOTE — the twelve-month headline
// places the axis, and a three-month wobble on a noisy monthly series is exactly
// the kind of reading that should not be able to move a verdict on its own.
export const REABSORPTION_FAST_CHANGE_MONTHS = 3;

// --- The paired state (new 2026-07) ---
//
// Attribution and reabsorption are independent axes, and the pairing is the
// discriminator neither one is on its own:
//
//   gap widening + aggregate holding      -> REALLOCATION
//   gap widening + aggregate deteriorating -> DISPLACEMENT
//   gap flat     + aggregate deteriorating -> NOT_AI
//   gap flat     + aggregate holding       -> STABLE
//
// THE TWO AXES ARE MEASURED IN DIFFERENT UNITS AND HAVE SEPARATE LINES. They were
// briefly forced onto a single z threshold, which read tidily and was wrong: a
// differential between two industry groups and an economy-wide employment level are
// not the same kind of quantity, and a shared threshold only hid that.
//
// Attribution is a differential, so a z against its own fixed baseline is the right
// scale, and it reuses the registered attention line rather than adding a tunable.
// BOTH AXES NOW SIT AT ZERO, and zero is a fact about each measure rather than a
// choice anyone has to defend.
//
// The grid is a DISPLAY, not a trigger. That distinction is what was wrong before:
// one number was asked both to draw a quadrant boundary and to fire an alarm, and it
// came out simultaneously too strict historically (8 of 10 baseline years past it)
// and too slow currently (1.25 points of headroom while the series fell half a point
// in a quarter). Splitting the two dissolves the problem instead of retuning it.
//
// A display is allowed to be sensitive. One month landing in a bad quadrant is a data
// point rather than an alarm, and deciding whether it is a trend or a single noisy
// print is the analyst's job. The trigger lives in the stoplight instead, below.
export const ATTRIBUTION_AXIS_Z = 0.0; // gap at or wider than its own 2010s norm

// HOW LONG THE GAP MUST STAY WIDE BEFORE THE GRID WILL CALL ANYTHING AI-SHAPED.
// New 2026-07-28, and it is a public registration rather than a tweak.
//
// The problem it fixes: the horizontal axis was established by a SINGLE month at or
// past its line, and the gap has sat past that line continuously since 2023. So the
// horizontal axis never changed the quadrant, and every colour change on the grid
// came from the vertical one — a 12-month change in prime-age employment sitting
// near zero, which crossed it eight times in the last eighteen months. That axis is
// economy-wide by construction. An ordinary recession moves it with no AI content at
// all, and it was the only thing deciding whether the card said "jobs are moving" or
// "jobs are going away". A grid whose AI-specific axis cannot change the answer is
// not discriminating; it is a cyclical indicator wearing a 2x2.
//
// So the attribution axis now has to HOLD. Three consecutive readings at or past the
// line before the gap counts as established, and until it does the vertical axis on
// its own lands in NOT_AI — an ordinary downturn — which is exactly what a weak
// aggregate with no confirmed exposed-industry divergence is.
//
// Why three and not a 12-month rate of change: a year is too long to wait for an
// early-warning display on AI timescales, and a change test asks a different
// question (is it getting worse) from the one this axis is for (is it diverging).
// Three months is the shortest run that cannot be produced by one noisy print, and
// it matches PAIRED_STATE_PERSISTENCE_MONTHS in the app so the grid and the card
// speak about confirmation on the same timescale.
//
// NOTE WHAT THIS DOES NOT CHANGE: the gap is currently wide AND has been for years,
// so today's reading is unaffected. This is a guard against a future month, not a
// retune to move the present one.
export const ATTRIBUTION_SUSTAIN_MONTHS = 3;

// Vertical: the 12-month change in prime-age employment-population, against zero.
// Falling at all counts as deterioration.
//
// A CHANGE against RAW ZERO, not a z of the change. Scoring the change against the
// 2010-2019 distribution was the original error: that decade rose about +0.53 a year
// while recovering from the financial crisis, so strongly positive changes were
// structurally normal in it and any ordinary expansion year read as deteriorating.
// Zero involves no distribution at all, so there is nothing to contaminate, and it
// removes the reference-year judgement entirely.
//
// Validated against history before adoption: it never once calls the 2014-2019 boom
// displacement, and fires on 27% of the observation period including now.
export const REABSORPTION_AXIS_LINE = 0.0;

// The "historical norm" ring on the four-corner grid: how many standard deviations of
// the FIXED baseline, per axis, count as the range that decade occupied on both axes
// at once.
//
// Two, which holds 109 of the 120 baseline months. Registered here rather than chosen
// at the drawing site because it is now sent to the analyst, and a number a model
// reasons about belongs where every other pre-registered value lives.
//
// Checked before adoption that it does not swallow the period it is meant to judge:
// 34 of the 41 observation months fall outside it, and against the one-sigma version
// not a single one falls inside. A norm marker that contains the thing being judged
// would prove nothing while looking like evidence.
export const JOINT_BASELINE_SIGMAS = 2.0;

// The early-warning TRIGGER. Separate from the display above, and it lives in the
// stoplight. Exposed-industry employment falling this much year-over-year is the
// pre-registered warning line.
//
// NOTE IT IS ALREADY CROSSED: exposed employment is at -1.3% today. That is intended
// rather than a surprise, and it is stated here so nobody discovers it later and
// assumes the line was drawn to fit.
export const EARLY_WARNING_EXPOSED_JOB_LOSS_PCT = -1.0;
// Reabsorption is a level, so its line is REABSORPTION_SHORTFALL_POINTS above.
//
// This state is COMPUTED AND STORED, and it is never sent to the analyst. See
// analyst/pairedState.mjs for that boundary and why it is drawn there.

// --- Individual-level wage growth: stayers against switchers (new 2026-07-28) ---
//
// THE COMPOSITION-IMMUNE CONTROL. Every other pay measure on this dashboard is an
// industry AVERAGE, and an average over a group moves when the group changes even
// if nobody's pay does. That is not a hypothetical here: if entry-level hiring in
// exposed industries stops, the surviving exposed workforce skews senior and
// average pay growth RISES for a reason that has nothing to do with anyone's
// bargaining power — and rising exposed pay is currently the strongest single piece
// of evidence against the displacement reading. The dashboard could not tell the two
// apart, so this is the panel that can.
//
// The Atlanta Fed tracker follows THE SAME INDIVIDUALS twelve months apart and
// reports the median of their wage changes. Composition cannot move it, because the
// unit of observation is a person rather than a payroll total.
//
// THE STAYER/SWITCHER SPREAD IS THE SECOND READING, and it is the cleanest thing
// here on whether people are landing WELL. Switchers ahead of stayers means moving
// jobs pays, so mobility is opportunity-driven. Switchers behind stayers means people
// are moving and taking less, which is what forced mobility looks like — and that is
// exactly the pattern a displacement episode absorbed into worse work would produce
// while the headline employment count held up.
//
// Both ids verified against FRED 2026-07-29 (titles as returned):
//   FRBATLWGT12MMUMHWGJST — "12-Month Moving Average of Unweighted Median Hourly
//     Wage Growth: Job Stayer", percent change from year ago, monthly, NSA, 1997-12+
//   FRBATLWGT12MMUMHWGJSW — the same for "Job Switcher", 1997-12+
export const INDIVIDUAL_WAGE_GROWTH = {
  jobStayer: "FRBATLWGT12MMUMHWGJST",
  jobSwitcher: "FRBATLWGT12MMUMHWGJSW",
};

// --- Macro-regime gate series (the recession-veto inputs) ---
export const MACRO_SPREAD_IDS = ["T10Y2Y", "T10Y3M"];

// Series the verdict cannot be derived without (finding 2): if any of these
// is absent from the pool, absence must read as "no data", never as benign.
export const VERDICT_CRITICAL_SERIES = [
  ...DIFFERENTIALS.jobs.exposed,
  ...DIFFERENTIALS.jobs.control,
  ...DIFFERENTIALS.wages.exposed,
  ...DIFFERENTIALS.wages.control,
  ...MACRO_SPREAD_IDS,
];
