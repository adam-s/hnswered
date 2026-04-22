/**
 * Verbose instrumentation used while diagnosing live behavior.
 *
 * Format: `[class.method] information ${data} ${Date.now()} ######`
 *
 * The trailing `######` marker makes it easy to grep the SW DevTools console
 * for hnswered lines. To disable, flip `DEBUG` to `false` and rebuild.
 */
export const DEBUG = false;

export function log(loc: string, msg: string): void {
  if (!DEBUG) return;
  // eslint-disable-next-line no-console
  console.log(`[${loc}] ${msg} ${Date.now()} ######`);
}

export function logErr(loc: string, msg: string, err: unknown): void {
  if (!DEBUG) return;
  const text = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.error(`[${loc}] ERR ${msg} err=${JSON.stringify(text)} ${Date.now()} ######`);
}
