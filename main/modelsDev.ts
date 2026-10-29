/**
 * models.dev (https://models.dev/api.json) for the AI assistant: each model's own output limit, so a request asks the
 * model for what it can give rather than a fixed number. The last copy is kept in the app's data folder and answers at
 * once; the network copy replaces it when it lands, with no time limit (a slow or stalled download never holds a reply
 * up, it just never replaces the copy). Nothing here throws.
 */
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';

const URL = 'https://models.dev/api.json';
type Registry = Record<string, { models?: Record<string, { limit?: { output?: number } }> }>;
let db: Registry | null = null;

/** Load the disk copy now and refresh it from the network in the background. */
export function initModelsDev(diskFile: string): void {
  try { if (existsSync(diskFile)) db = JSON.parse(readFileSync(diskFile, 'utf8')) as Registry; } catch { /* none yet */ }
  void (async () => {
    try {
      const res = await fetch(URL);
      if (!res.ok) return;
      const text = await res.text();
      db = JSON.parse(text) as Registry;
      try { writeFileSync(`${diskFile}.tmp`, text); renameSync(`${diskFile}.tmp`, diskFile); } catch { /* the copy is a convenience */ }
    } catch { /* offline: the disk copy stays */ }
  })();
}

/** Tests: answer from this registry. */
export function __setModelsDevForTest(value: Registry | null): void { db = value; }

/** The model's own output limit: under the provider's key first (anthropic / openai), else any provider listing the
 *  exact id; null when models.dev does not know it (or has not loaded). */
export function modelOutputLimit(provider: string, model: string): number | null {
  if (!db || !model) return null;
  const entry = db[provider]?.models?.[model] ?? Object.values(db).map((p) => p?.models?.[model]).find(Boolean);
  const n = Number(entry?.limit?.output);
  return Number.isFinite(n) && n > 0 ? n : null;
}
