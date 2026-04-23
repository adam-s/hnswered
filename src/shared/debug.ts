/**
 * Shared debug logger for the background SW and the sidepanel.
 *
 * Format: `2026-04-23T15:23:01.123Z [class.method] message {data}`
 *
 * ISO timestamp is the FIRST token so lines sort chronologically when you
 * paste output from the SW DevTools and the sidepanel DevTools into one
 * buffer — that's the whole point of correlating across async boundaries.
 *
 * To diagnose live behavior: flip `DEBUG` to `true`, rebuild, observe in
 * chrome://extensions → "service worker" devtools (background) and the
 * sidepanel's own devtools (right-click → Inspect). Revert before shipping.
 */
export const DEBUG = false;

type DataFactory = () => Record<string, unknown>;

export function log(loc: string, msg: string, data?: DataFactory): void {
  if (!DEBUG) return;
  const tail = data ? ` ${safeJson(data)}` : '';
  // eslint-disable-next-line no-console
  console.log(`${new Date().toISOString()} [${loc}] ${msg}${tail}`);
}

export function logErr(loc: string, msg: string, err: unknown): void {
  if (!DEBUG) return;
  const text = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.error(`${new Date().toISOString()} [${loc}] ERR ${msg} err=${JSON.stringify(text)}`);
}

function safeJson(factory: DataFactory): string {
  try {
    return JSON.stringify(factory());
  } catch (e) {
    return JSON.stringify({ _error: (e as Error).message });
  }
}
