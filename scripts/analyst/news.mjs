// Designed with Claude (Anthropic)
//
// assembleNews — fetches the allowlist into the monthly package the analyst
// receives as STATIC text. Fail-soft by design: any source that errors is logged
// with a status and skipped; the run never aborts on a news fetch. This runs in
// the GitHub Action only; the app never touches the open web.

import { ALLOWLIST, JOBS_KEYWORDS } from "./allowlist.mjs";

const UA = "Mozilla/5.0 (compatible; ai-labor-dashboard-analyst/1.0; +https://github.com/DoubleJ0n/ai-labor-dashboard-data)";
const RECENT_DAYS = 45;

async function fetchText(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "user-agent": UA, accept: "*/*" }, signal: ctrl.signal });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, body: await res.text() };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  } finally {
    clearTimeout(t);
  }
}

const sorted = (obs) => [...(obs ?? [])].sort((a, b) => a.date.localeCompare(b.date));

/** BLS ground truth FROM THE POOL — payrolls, unemployment, month-over-month. */
function blsFromPool(pool, nowMs) {
  const series = pool.fred?.series ?? {};
  const payems = sorted(series.PAYEMS);
  const unrate = sorted(series.UNRATE);
  if (!payems.length || !unrate.length) {
    return { status: "absent", note: "no BLS payroll/unemployment data in the pool", text: null, dataMonth: null };
  }
  const p = payems[payems.length - 1];
  const pPrev = payems[payems.length - 2];
  const u = unrate[unrate.length - 1];
  const mom = pPrev ? Math.round(p.value - pPrev.value) : null;
  const dataMonth = p.date.slice(0, 7);
  const text =
    `BLS Employment Situation (ground truth, from the data pool; through ${dataMonth}): ` +
    `total nonfarm payrolls ${Math.round(p.value).toLocaleString("en-US")} thousand` +
    (mom == null ? "" : ` (${mom >= 0 ? "+" : ""}${mom.toLocaleString("en-US")} thousand vs the prior month)`) +
    `; unemployment rate ${u.value}% (as of ${u.date.slice(0, 7)}). ` +
    `Note: revisions to prior months are legitimate veto material.`;
  return { status: "fetched", note: "from pool FRED numbers", text, dataMonth };
}

/** Pull recent, jobs-relevant AP article links from the hub (headline-level scrape). */
function extractApHeadlines(html, max = 5) {
  const hrefs = [...html.matchAll(/href="(https:\/\/apnews\.com\/article\/[^"]+)"/g)].map((m) => m[1]);
  const seen = new Set();
  const out = [];
  for (const url of hrefs) {
    if (seen.has(url)) continue;
    seen.add(url);
    // Headline from the slug: drop the trailing hex id, de-hyphenate.
    const slug = url.split("/article/")[1]?.split(/[?#]/)[0] ?? "";
    const title = slug.replace(/-[0-9a-f]{16,}$/i, "").replace(/-/g, " ").trim();
    if (!title || !JOBS_KEYWORDS.test(title + " " + url)) continue;
    out.push({ title, url });
    if (out.length >= max) break;
  }
  return out;
}

const stripTag = (s) =>
  (s ?? "").replace(/<!\[CDATA\[/g, "").replace(/\]\]>/g, "").replace(/<[^>]*>/g, "").trim();

/** Recent jobs-relevant items from an RSS feed. */
function extractRssItems(xml, nowMs, max = 4) {
  const items = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map((m) => m[1]);
  const out = [];
  for (const it of items) {
    const title = stripTag((it.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i) || [])[1]);
    const link = stripTag((it.match(/<link\b[^>]*>([\s\S]*?)<\/link>/i) || [])[1]);
    const pub = stripTag((it.match(/<pubDate\b[^>]*>([\s\S]*?)<\/pubDate>/i) || [])[1]);
    if (!title) continue;
    if (pub) {
      const ts = Date.parse(pub);
      if (Number.isFinite(ts) && nowMs - ts > RECENT_DAYS * 86400000) continue; // too old
    }
    if (!JOBS_KEYWORDS.test(title)) continue;
    out.push({ title, url: link });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Build the monthly news package. Returns { text, sources, dataMonth }.
 * @param {object} pool the loaded data pool (for BLS-from-pool)
 * @param {number} nowMs current epoch ms (recency filter); pass from the caller
 */
export async function assembleNews(pool, nowMs) {
  const sources = [];
  const blocks = [];
  let dataMonth = null;

  for (const src of ALLOWLIST) {
    if (src.mechanism === "pool") {
      const r = blsFromPool(pool, nowMs);
      dataMonth = r.dataMonth ?? dataMonth;
      sources.push({ id: src.id, role: src.role, status: r.status, note: r.note });
      if (r.text) blocks.push(`[${src.label} — ${src.role}]\n${r.text}`);
      continue;
    }
    const r = await fetchText(src.url);
    if (!r.ok) {
      sources.push({ id: src.id, role: src.role, status: "failed", note: r.error });
      continue;
    }
    let items = [];
    if (src.mechanism === "scrape") items = extractApHeadlines(r.body);
    else if (src.mechanism === "rss") items = extractRssItems(r.body, nowMs);
    if (!items.length) {
      sources.push({ id: src.id, role: src.role, status: "no_relevant_items", note: src.optional ? "optional; absence is normal" : "fetched, nothing jobs-relevant" });
      continue;
    }
    sources.push({ id: src.id, role: src.role, status: "fetched", note: `${items.length} item(s)` });
    blocks.push(
      `[${src.label} — ${src.role}]\n` +
        items.map((i) => `- ${i.title}${i.url ? ` (${i.url})` : ""}`).join("\n"),
    );
  }

  const gaps = sources.filter((s) => s.status === "failed").map((s) => s.id);
  const header =
    "MONTHLY NEWS PACKAGE (allowlist-only, static). Context and veto raw material only — " +
    "it may downgrade a directional verdict to CONFOUNDED via a specific named mechanism, " +
    "but may never produce or strengthen a directional verdict." +
    (gaps.length ? ` Fetch gaps this month (run proceeds anyway): ${gaps.join(", ")}.` : "");

  return { text: `${header}\n\n${blocks.join("\n\n")}`, sources, dataMonth };
}
