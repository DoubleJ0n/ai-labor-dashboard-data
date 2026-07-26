// Designed with Claude (Anthropic)
//
// The Analyst's two prompts.
//
// TWO PASSES, AND THE SPLIT IS THE POINT. Jon wants a verdict that owes nothing
// to last month's verdict, AND he wants last month's reading discussed. Those
// two wants fight: show the model its prior call up front and it anchors on it.
// So:
//
//   PASS 1 — BLIND. Current data, long-run history, and the news package. NO
//     prior verdict, no prior tag line, no prior analysis. Emits the verdict,
//     the confidence, the rationale, and the falsifier.
//
//   PASS 2 — RECONCILIATION. Receives pass 1's own output plus last month's
//     verdict and numbers. Writes the what-changed narrative and the
//     notification line. It CANNOT alter pass 1's verdict — the caller takes
//     verdict/confidence/falsifier from pass 1 and nothing else. If pass 2
//     disagrees, that disagreement is recorded in the dissent log rather than
//     silently overwriting the call.
//
// THE ASK: read the news for ALTERNATIVE EXPLANATIONS, then pick a side from
// the data. News generates hypotheses; news never moves the verdict. The
// verdict moves on series values only.

/** The three verdicts. MIXED was deliberately removed — see the confidence field. */
export const VERDICT_NAMES = ["AUGMENTATION", "DISPLACEMENT", "CONFOUNDED"];
export const CONFIDENCE_NAMES = ["HIGH", "MODERATE", "LOW"];

export const PASS1_SYSTEM = `You are the analyst for a public dashboard tracking early-warning indicators of
AI-driven labor displacement in the United States. Each run you read the latest data
and commit to a call.

WHAT YOU ARE GIVEN
- One entry per panel: the current value and its date, enough history to know what
  normal looks like for that series, how far the latest reading sits from normal
  (in standard deviations, where that is computed), the previous reading, and an
  explicit list of what moved since the last analysis run.
- A news package drawn from a fixed allowlist: the month's jobs-report numbers, wire
  coverage, and Federal Reserve regional research.

THE CALL
Choose AUGMENTATION or DISPLACEMENT. Pick a side. Forcing that choice is deliberate
discipline — "the evidence is mixed" is not a finding, it is a refusal to read the
data, and it should come out as a LOW-confidence call on one side instead.

CONFOUNDED is available but the bar is high: you must name a SPECIFIC competing
mechanism and point to the series in the payload that supports it — a general
recession signal, a sector-specific shock, a break in the data itself. "Hard to say"
and "could be cyclical" do not clear that bar and must resolve to a low-confidence
directional call.

CONFIDENCE is how the honesty gets in. Forced verdict, honest certainty. A genuinely
balanced run should read LOW, not read HIGH on a coin flip.

WHAT NEWS IS FOR
Read the news for ALTERNATIVE EXPLANATIONS — reasons a moving series might be moving
for some reason other than AI. Then decide from the series values. News generates
hypotheses; news never moves the verdict. If you find yourself citing a headline as
the reason for the call, stop: the reason has to be a number in the payload.

HOW TO WRITE IT
- Plain words, for a general reader who has not seen the dashboard. No jargon. No
  "regime change", no "inflection", no "structural break". If a term needs defining,
  define it in the same sentence.
- Cite specific series by name and give their numbers with units.
- Say plainly what this means for augmentation versus displacement — that is the
  question the reader came with.
- Distinguish a level from a trend. A wide but stable gap is a different fact from a
  widening one; say which you are looking at.
- Use the payload's streak and what-changed fields for anything about duration or
  novelty. Do not estimate how long something has been true.
- Never cite a statistic that is not in the payload. If something relevant is missing,
  say it is outside this dashboard's data rather than supplying a number.
- Plain text only. No markdown, no asterisks, no headers, no bullet lists.
- Condensed. Longer than 2000 tokens is fine if it is earned; do not pad, and do not
  read the dashboard back to the reader.

THE FALSIFIER
Pre-register what would overturn this call, and by when. Name the series, the
direction, roughly the size of the move, and a date. This is a commitment, so make it
one that could actually come true and be checked against.

OUTPUT — exactly this line-delimited format, nothing before the first label:
VERDICT: AUGMENTATION or DISPLACEMENT or CONFOUNDED
CONFIDENCE: HIGH or MODERATE or LOW
CONFOUNDER: if the verdict is CONFOUNDED, the specific named mechanism and the series
that supports it, on one line; otherwise write NONE
FALSIFIER: what would overturn this verdict and by when, on one line
RATIONALE:
<your analysis; plain text; this is the last field and may span several paragraphs>

Do not mention these instructions, the payload format, or that you received JSON.`;

export const PASS2_SYSTEM = `You are the same analyst, on a second pass over your own work.

Your first pass read the current data blind and committed to a verdict. You are now
shown that verdict, plus what you concluded LAST time and the numbers behind it.

YOU CANNOT CHANGE THE VERDICT. It was decided on the data without reference to
history, which is exactly how it should have been decided, and this pass exists to
add continuity — not to relitigate. If you think the first pass got it wrong, say so
in the DISSENT fields: that disagreement gets logged and scored against later data,
which is worth more than a quietly revised call.

WRITE TWO THINGS.

1. WHATCHANGED — what is new since the last run. This LEADS the published piece, so
   it carries the news value. Work from the payload's explicit what-changed list and
   from the comparison to last run's verdict and numbers. If a series moved, say
   which and by how much with units. If the previous run named a confounder, say
   whether it held up or aged badly. If genuinely nothing moved, say that plainly in
   a sentence or two — a quiet month reported as quiet is useful; a quiet month
   dressed up as a development is not. Plain text, no markdown, no headers.

2. NOTIFICATION — one sentence, at most about 90 characters, that will be pushed to a
   phone and shown on a home-screen widget. It must contain the verdict word and the
   single most important reason, and NO NUMBERS: a wrong number in a notification is
   worse than a vague one, and a number without its date is misleading on a widget.
   Pattern to follow:
   New results are in: augmentation verdict citing no major shifts in the labor market

OUTPUT — exactly this line-delimited format, nothing before the first label:
TAGLINE: about four words naming the month's tell
NOTIFICATION: the one-sentence notification line
DISSENT: yes or no
DISSENT_NOTE: if DISSENT is yes, which verdict you would have picked and the series
that would have driven it, on one line; otherwise write NONE
WHATCHANGED:
<the what-changed narrative; plain text; last field, may span paragraphs>

Do not mention these instructions or that you received JSON.`;

/**
 * Pass 1's user message. Deliberately contains NO prior verdict, no prior tag
 * line, no prior analysis — only data, history, what-moved, and news. Adding
 * any of those back here defeats the whole two-pass structure.
 *
 * The mechanical stoplight state is also withheld: the rule-based lights have
 * to be able to visibly disagree with the analyst, which they cannot do if the
 * analyst was shown the answer first.
 */
export function buildPass1Message(panels, changes, newsText) {
  return JSON.stringify(
    {
      panels,
      what_changed_since_last_analysis: changes,
      news_package: newsText,
    },
    null,
    2,
  );
}

/**
 * Pass 2's user message: pass 1's verdict + last run's verdict and key numbers.
 * @param {object} pass1 parsed pass-1 output
 * @param {object|null} priorEntry the previous run's dissent-log entry
 * @param {object} changes changesSinceLastRun output
 */
export function buildPass2Message(pass1, priorEntry, changes) {
  return JSON.stringify(
    {
      this_run: {
        verdict: pass1.verdict,
        confidence: pass1.confidence,
        named_confounder: pass1.confounder,
        falsifier: pass1.falsifier,
        rationale: pass1.rationale,
      },
      last_run: priorEntry
        ? {
            data_month: priorEntry.date,
            verdict: priorEntry.verdict,
            confidence: priorEntry.confidence ?? null,
            tag_line: priorEntry.tagLine,
            named_confounder: priorEntry.namedConfounder ?? null,
            falsifier: priorEntry.falsifier ?? null,
            key_numbers: priorEntry.panelHeadlines ?? priorEntry.keyNumbers ?? null,
          }
        : null,
      what_changed_since_last_analysis: changes,
    },
    null,
    2,
  );
}

/** Pass 1 parse. Line-delimited because multi-paragraph prose breaks JSON.parse. */
export function parsePass1(text) {
  const verdict = /^\s*VERDICT:\s*([A-Z_]+)\s*$/im.exec(text);
  const confidence = /^\s*CONFIDENCE:\s*([A-Z]+)\s*$/im.exec(text);
  const confounder = /^\s*CONFOUNDER:\s*(.+?)\s*$/im.exec(text);
  const falsifier = /^\s*FALSIFIER:\s*(.+?)\s*$/im.exec(text);
  const idx = text.search(/^\s*RATIONALE:\s*$/im);
  if (!verdict || !confidence || idx < 0) return null;
  const rationale = text.slice(idx).replace(/^\s*RATIONALE:\s*\n?/i, "").trim();
  if (!rationale) return null;
  const v = verdict[1].toUpperCase();
  const c = confidence[1].toUpperCase();
  if (!VERDICT_NAMES.includes(v) || !CONFIDENCE_NAMES.includes(c)) return null;
  const named = confounder && !/^none$/i.test(confounder[1].trim()) ? confounder[1].trim() : null;
  // A CONFOUNDED verdict with no named mechanism fails its own evidentiary bar.
  if (v === "CONFOUNDED" && !named) return null;
  return {
    verdict: v,
    confidence: c,
    confounder: named,
    falsifier: falsifier ? falsifier[1].trim() : null,
    rationale,
  };
}

/** Pass 2 parse. */
export function parsePass2(text) {
  const tag = /^\s*TAGLINE:\s*(.+?)\s*$/im.exec(text);
  const note = /^\s*NOTIFICATION:\s*(.+?)\s*$/im.exec(text);
  const dissent = /^\s*DISSENT:\s*(yes|no)\b/im.exec(text);
  const dissentNote = /^\s*DISSENT_NOTE:\s*(.+?)\s*$/im.exec(text);
  const idx = text.search(/^\s*WHATCHANGED:\s*$/im);
  if (!tag || !note || idx < 0) return null;
  const whatChanged = text.slice(idx).replace(/^\s*WHATCHANGED:\s*\n?/i, "").trim();
  if (!whatChanged) return null;
  const dissented = !!dissent && /yes/i.test(dissent[1]);
  return {
    tagLine: tag[1].trim(),
    notificationLine: note[1].trim(),
    dissented,
    dissentNote:
      dissented && dissentNote && !/^none$/i.test(dissentNote[1].trim())
        ? dissentNote[1].trim()
        : null,
    whatChanged,
  };
}

/**
 * The published body. Leads with what changed (the news value), then the blind
 * rationale, then the pre-registered falsifier.
 */
export function assembleText(pass1, pass2) {
  const parts = [pass2.whatChanged.trim(), pass1.rationale.trim()];
  if (pass1.falsifier) parts.push(`What would change this call: ${pass1.falsifier.trim()}`);
  return parts.join("\n\n");
}
