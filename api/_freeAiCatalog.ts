/**
 * AI Craft — AgentRouter Model Catalog
 *
 * Baseline models provided by AgentRouter (refreshed dynamically from
 * `${AGENTROUTER_BASE_URL}/models` when available).
 */

export const FREE_MODEL_CATALOG: Record<string, string[]> = {
  agentrouter: [
    'gpt-6.2-sol',
    'gpt-6.2-astra',
    'gpt-5.6-sol',
    'gpt-6.1-sol',
    'claude-opus-5-5',
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
