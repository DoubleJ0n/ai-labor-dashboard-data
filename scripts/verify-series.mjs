// Designed with Claude (Anthropic)
//
// Series-ID verifier. FRED is unreachable from the maintainer's machine (403 to
// automated fetches, timeouts otherwise), so candidate series IDs cannot be
// checked locally, and the standing rule is that an unverified series ID never
// gets wired. This runs in Actions where the key lives, reports what each
// candidate actually is, and writes nothing.
//
//   node scripts/verify-series.mjs ECIWAG FRBATLWGT3MMAUMHWGO
//
// Prints, per id: whether it exists, its title, units, seasonal adjustment,
// frequency, and observation range. Exit code is non-zero only if EVERY id is
// bad, so a partial result still surfaces in the log.
const KEY = process.env.FRED_API_KEY;
if (!KEY) {
  console.error("verify-series: FRED_API_KEY is not set");
  process.exit(2);
}

const ids = process.argv.slice(2);
if (ids.length === 0) {
  console.error("verify-series: pass one or more series ids");
  process.exit(2);
}

let found = 0;
for (const id of ids) {
  const url = `https://api.stlouisfed.org/fred/series?series_id=${encodeURIComponent(id)}&api_key=${KEY}&file_type=json`;
  try {
    const r = await fetch(url);
    if (!r.ok) {
      console.log(`${id.padEnd(24)} NOT FOUND (HTTP ${r.status})`);
      continue;
    }
    const j = await r.json();
    const s = j.seriess?.[0];
    if (!s) {
      console.log(`${id.padEnd(24)} NOT FOUND (empty response)`);
      continue;
    }
    found++;
    console.log(`${id.padEnd(24)} OK`);
    console.log(`  title      : ${s.title}`);
    console.log(`  units      : ${s.units}`);
    console.log(`  adjustment : ${s.seasonal_adjustment}`);
    console.log(`  frequency  : ${s.frequency}`);
    console.log(`  range      : ${s.observation_start} .. ${s.observation_end}`);
    console.log(`  updated    : ${s.last_updated}`);
  } catch (e) {
    console.log(`${id.padEnd(24)} ERROR ${e.message ?? e}`);
  }
}

console.log(`\n${found} of ${ids.length} verified.`);
process.exit(found === 0 ? 1 : 0);
