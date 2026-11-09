// Designed with Claude (Anthropic)
// Shared helpers for the dashboard-data.json pool. Each refresh script
// re-reads the file, replaces ONLY its own top-level section, and writes the
// whole file back (last-write-wins per section; other sections untouched).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const POOL_PATH = path.join(repoRoot, "dashboard-data.json");

export function loadPool() {
  return JSON.parse(readFileSync(POOL_PATH, "utf8"));
}

/** Replace one top-level section and persist. Never clobbers other sections. */
export function saveSection(sectionName, sectionValue) {
  const pool = loadPool();
  pool[sectionName] = sectionValue;
  writeFileSync(POOL_PATH, JSON.stringify(pool, null, 2) + "\n", "utf8");
}

export function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

/** Extracts the last ```json fenced block from model output (mirrors the app's extractJson). */
export function extractFencedJson(text) {
  const matches = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  if (matches.length === 0) return null;
  try {
    return JSON.parse(matches[matches.length - 1][1].trim());
  } catch {
    return null;
  }
}

// --- Shared transient-fetch retry -------------------------------------------
// LIFTED OUT OF postings-refresh.mjs (2026-11-09), which worked this out first and
// whose comment is still the best statement of why: a transient upstream condition
// reported as a data failure "fires often enough to teach you to ignore red runs, which
// is the expensive part." It stayed local to that one script, so every other job kept
// failing on the first hiccup — fred-refresh died on 2026-10-21 on a single bad response
// and the whole FRED panel went red for the day.
//
// Retry only what a second ask can fix: network throws, 429, and 5xx. A 404 or a
// restructured feed is a real problem and must still stop the job on the first response.
export const DEFAULT_RETRY_DELAYS_MS = [2_000, 8_000, 30_000];

export async function fetchWithRetry(url, {
  init = {},
  delays = DEFAULT_RETRY_DELAYS_MS,
  label = String(url),
} = {}) {
  for (let attempt = 0; ; attempt++) {
    const last = attempt >= delays.length;
    let response;
    try {
      response = await fetch(url, init);
    } catch (e) {
      if (last) throw new Error(`${label}: fetch threw after ${delays.length + 1} attempts (${e.message ?? e})`);
      await sleepBeforeRetry(label, attempt, delays, `fetch threw (${e.message ?? e})`);
      continue;
    }
    if (response.ok) return response;

    const transient = response.status === 429 || response.status >= 500;
    if (!transient || last) {
      throw new Error(
        `${label}: HTTP ${response.status}` +
          (transient ? ` after ${delays.length + 1} attempts — upstream is still throttling or down` : ""),
      );
    }
    // Honour Retry-After when the server sends one; it knows better than the table.
    const retryAfter = Number(response.headers.get("retry-after"));
    await sleepBeforeRetry(label, attempt, delays, `HTTP ${response.status}`,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null);
  }
}

async function sleepBeforeRetry(label, attempt, delays, reason, overrideMs = null) {
  const waitMs = overrideMs ?? delays[attempt];
  console.warn(`${label}: ${reason}; retrying in ${Math.round(waitMs / 1000)}s (attempt ${attempt + 2} of ${delays.length + 1})`);
  await new Promise((resolve) => setTimeout(resolve, waitMs));
}

// A 200 WITH THE WRONG BODY IS NOT A SUCCESS. This repo has met that twice: the BTOS
// data page answers every wrong filename with an HTTP 200 soft-404, and on 2026-10-21
// FRED answered 200 with an HTML maintenance page, which reached JSON.parse and surfaced
// as `SyntaxError: Unexpected token '<'` — a message that says nothing about what
// happened. Parse explicitly so the failure names itself.
export function parseJsonOrThrow(text, label) {
  try {
    return JSON.parse(text);
  } catch (e) {
    const head = text.slice(0, 160).replace(/\s+/g, " ").trim();
    throw new Error(
      `${label}: upstream returned a non-JSON body (${e.message}). ` +
        `First 160 chars: ${head || "(empty)"} — likely an HTML error or maintenance page served with a 200.`,
    );
  }
}
