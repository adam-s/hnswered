/**
 * Record/replay fetch transport for the harness.
 *
 * Patches globalThis.fetch. The production HN client at src/background/hn-client.ts
 * goes through this without modification.
 *
 * RECORD mode: hits live HN, captures the body, truncates `text` fields on HN items
 *              to TEXT_TRUNCATE_LEN chars (with `__textTruncatedFrom: <origLen>`
 *              marker), appends to the in-memory tape, and returns the ORIGINAL
 *              (untruncated) body to the caller. Truncation only affects what's
 *              written to disk; production code under test still sees real text
 *              during recording.
 *
 * REPLAY mode: looks up the URL in the tape; throws TapeMiss if absent or if
 *              the per-URL cursor exceeds the recorded calls. Strips `__`-prefixed
 *              metadata fields from the response before handing to the caller.
 *              Same-URL retries are consumed in order via a per-URL counter.
 *
 * KNOWN LIMITATION (recordings under HN instability):
 *   When the recording hit non-200 status responses (502, 429, etc.), the
 *   recorder captures both the failure and the production retry-backoff fetch
 *   that followed. On replay, the failure response is served at zero latency,
 *   then production code's hn-client.fetchJSON sleeps via REAL setTimeout for
 *   FETCH.BACKOFF_BASE_MS * 2^attempt (capped at 10s) before re-fetching. Up
 *   to 3 retries per URL × multiple URLs can accumulate enough real wall time
 *   to approach the chrome shim's 30s dispatchMessage timeout, producing a
 *   misleading "never called sendResponse" error that masks the retried-URL
 *   root cause.
 *
 *   Mitigation: prefer to record under stable HN conditions; if a tape contains
 *   non-200s, inspect tape.json after recording and re-record under better
 *   conditions, OR pass `dispatchMessage(msg, { timeoutMs: 90_000 })` to the
 *   harness driver in scenarios that exercise such tapes.
 */

const HN_FIREBASE_PREFIX = 'https://hacker-news.firebaseio.com/';
const HN_ALGOLIA_PREFIX = 'https://hn.algolia.com/';
const TEXT_TRUNCATE_LEN = 10;

function isHnUrl(url: string): boolean {
  return url.startsWith(HN_FIREBASE_PREFIX) || url.startsWith(HN_ALGOLIA_PREFIX);
}

export interface TapeCall {
  url: string;
  status: number;
  response: unknown;
}

export interface Tape {
  recordedAt: number;
  scenario: string;
  user: string;
  calls: TapeCall[];
}

export class TapeMiss extends Error {
  readonly url: string;
  constructor(url: string) {
    super(`no recorded response for ${url}`);
    this.name = 'TapeMiss';
    this.url = url;
  }
}

export interface TransportHandle {
  /** All HN URLs requested through this transport, in call order. */
  hnRequests: string[];
  /** The in-memory tape — same reference as caller's `tape` if provided.
   *  In RECORD mode, mutated as calls are appended. */
  tape: Tape;
  uninstall(): void;
}

export interface InstallReplayOptions {
  mode: 'replay';
  tape: Tape;
}

export interface InstallRecordOptions {
  mode: 'record';
  tape: Tape;
  /** Real fetch to delegate to. Defaults to the original globalThis.fetch
   *  captured BEFORE installation. */
  realFetch?: typeof fetch;
}

export function installFetchTransport(opts: InstallReplayOptions | InstallRecordOptions): TransportHandle {
  const realFetch = (opts.mode === 'record' ? opts.realFetch : undefined) ?? globalThis.fetch.bind(globalThis);
  const prevFetch = globalThis.fetch;
  const hnRequests: string[] = [];

  // REPLAY: index calls by URL with a per-URL consumption counter to support
  // the rare case of the same URL being fetched twice in one scenario.
  const replayIndex = new Map<string, TapeCall[]>();
  const replayCursor = new Map<string, number>();
  if (opts.mode === 'replay') {
    for (const c of opts.tape.calls) {
      const list = replayIndex.get(c.url) ?? [];
      list.push(c);
      replayIndex.set(c.url, list);
    }
  }

  const wrapped: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (!isHnUrl(url)) {
      // Pass through anything not pointed at HN (defensive — production code
      // currently only fetches HN Firebase + Algolia URLs).
      return realFetch(input as RequestInfo, init);
    }
    hnRequests.push(url);

    if (opts.mode === 'replay') {
      const list = replayIndex.get(url);
      if (!list || list.length === 0) throw new TapeMiss(url);
      const cursor = replayCursor.get(url) ?? 0;
      // Strict overrun: if production code fetches the same URL more times
      // than the tape has entries, throw TapeMiss instead of silently
      // re-serving the last response. Re-serving was the prior behavior and
      // it masks infinite-loop regressions in the production code.
      if (cursor >= list.length) {
        throw new TapeMiss(`${url} (cursor ${cursor} exceeds ${list.length} recorded calls)`);
      }
      const call = list[cursor];
      replayCursor.set(url, cursor + 1);
      const stripped = stripUnderscoreMeta(call.response);
      // If the original response wasn't valid JSON, the recorder stored the
      // raw text under __rawText. Replay reproduces it verbatim so production
      // code sees the same parse failure (or non-JSON success body).
      const body = isRawTextEnvelope(call.response)
        ? (call.response as { __rawText: string }).__rawText
        : JSON.stringify(stripped);
      return new Response(body, {
        status: call.status,
        headers: { 'content-type': 'application/json' },
      });
    }

    // RECORD
    const res = await realFetch(input as RequestInfo, init);
    const cloned = res.clone();
    // Read body as text first so we can capture the raw string if JSON parsing
    // fails. The prior implementation silently turned non-JSON 200s into a
    // null body, which on replay was indistinguishable from a real `null` HN
    // response and hid retry-trigger conditions.
    let response: unknown;
    const rawText = await cloned.text();
    try {
      const parsed = JSON.parse(rawText);
      response = truncateText(parsed);
    } catch {
      // Preserve raw text in a tagged envelope. Replay sees the same body
      // verbatim, production code's JSON.parse fails the same way it did at
      // record time. The envelope is itself a JSON object so the tape file
      // stays JSON-parseable.
      response = { __rawText: rawText };
    }
    opts.tape.calls.push({ url, status: res.status, response });
    return res;
  };

  function isRawTextEnvelope(v: unknown): v is { __rawText: string } {
    return !!v && typeof v === 'object' && typeof (v as { __rawText?: unknown }).__rawText === 'string';
  }

  globalThis.fetch = wrapped;

  return {
    hnRequests,
    tape: opts.tape,
    uninstall() {
      globalThis.fetch = prevFetch;
    },
  };
}

/** Walk a JSON-shaped value and truncate any large text field (Firebase `text`,
 *  Algolia `comment_text`) to TEXT_TRUNCATE_LEN chars, recording the original
 *  length under `__textTruncatedFrom` / `__commentTextTruncatedFrom`. Mutation-free. */
function truncateText(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(truncateText);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'text' && typeof val === 'string' && val.length > TEXT_TRUNCATE_LEN) {
        out[k] = val.slice(0, TEXT_TRUNCATE_LEN);
        out.__textTruncatedFrom = val.length;
      } else if (k === 'comment_text' && typeof val === 'string' && val.length > TEXT_TRUNCATE_LEN) {
        out[k] = val.slice(0, TEXT_TRUNCATE_LEN);
        out.__commentTextTruncatedFrom = val.length;
      } else {
        out[k] = truncateText(val);
      }
    }
    return out;
  }
  return v;
}

/** Strip any `__`-prefixed keys (recorder metadata) from a replayed response. */
function stripUnderscoreMeta(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripUnderscoreMeta);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k.startsWith('__')) continue;
      out[k] = stripUnderscoreMeta(val);
    }
    return out;
  }
  return v;
}

export function emptyTape(scenario: string, user: string, recordedAt: number): Tape {
  return { recordedAt, scenario, user, calls: [] };
}
