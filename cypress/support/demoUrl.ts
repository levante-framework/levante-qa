/**
 * Resolve demo launch URL overrides from Cypress.expose / env.
 * BASE_URL → host for local core-tasks (e.g. http://localhost:8080)
 * QA_CAT   → force cat=true|false on the task query string
 */

function expose(key: string): string | null {
  const fn = (globalThis as { Cypress?: { expose?: (k: string) => unknown } }).Cypress?.expose;
  if (typeof fn !== 'function') return null;
  const value = fn(key);
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function resolveDemoBase(fallback: string): string {
  const override = expose('BASE_URL');
  if (!override) return fallback;
  return override.replace(/\/?$/, '/');
}

export function applyQaTaskParams(
  params: Record<string, string | number>,
): Record<string, string | number> {
  const out = { ...params };
  const cat = expose('QA_CAT');
  if (cat) out.cat = cat;
  return out;
}
