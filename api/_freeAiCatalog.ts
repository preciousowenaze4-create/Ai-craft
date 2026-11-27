/**
 * AI Craft — Gemini Model Catalog
 *
 * Baseline Gemini models powered by `@google/genai` (`GEMINI_API_KEY`).
 * Refreshed dynamically from `/v1beta/models` when configured.
 */

export const FREE_MODEL_CATALOG: Record<string, string[]> = {
  gemini: [
    'gemini-4-hydrogen',
    'gemini-3.1-flash-lite',
    'gemini-4-neon',
    'gemini-4-argon',
    'gemini-4-carbon',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
  ],
};

/** Total number of cataloged models (static baseline). */
export function staticCatalogSize(): number {
  let total = 0;
  for (const models of Object.values(FREE_MODEL_CATALOG)) {
    total += models.length;
  }
  return total;
}

/** Next UTC midnight — when daily quota counters reset. */
export function nextDailyResetAt(now: Date = new Date()): string {
  const next = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    0,
    0,
    0
  );
  return new Date(next).toISOString();
}

/** Current UTC calendar day (YYYY-MM-DD) — stamps daily quota keys. */
export function utcQuotaDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
