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
