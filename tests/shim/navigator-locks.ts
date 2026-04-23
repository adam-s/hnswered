/**
 * Tiny in-process navigator.locks shim for the harness.
 *
 * Web Locks API doesn't exist in Node. The production background module uses
 * `navigator.locks.request(name, [options], fn)` to serialize tick/refresh work
 * across SW + sidepanel contexts. This shim models a single context (the
 * harness process) — enough to exercise queueing semantics that the real API
 * provides.
 *
 * Implements the subset hnswered uses:
 *   - request(name, fn)                            — exclusive, queue if held
 *   - request(name, options, fn)                   — same, with options
 *   - options.ifAvailable: true                    — invoke fn(null) if held,
 *                                                    do NOT queue, do NOT block
 *   - options.mode: 'exclusive' (default)          — only mode we need
 *   - options.signal: AbortSignal                  — abort the wait (not running)
 *
 * NOT implemented:
 *   - mode: 'shared'                               — not used by hnswered
 *   - LockManager.query()                          — not used
 *   - Cross-context serialization                  — single Node process; the
 *     real API serializes across SW + every open sidepanel. The harness only
 *     drives one "context" at a time so the per-name promise chain is enough.
 *
 * Behavior under contention:
 *   Caller A: request('tick', fn)                  → grants immediately
 *   Caller B: request('tick', fn)                  → queues, runs after A
 *   Caller C: request('tick', { ifAvailable }, fn) → fn(null), returns immediately
 *
 * Cleanup: per-name chain is auto-cleaned when the last queued caller finishes.
 * No explicit lifetime to manage — install once per process, forget.
 */

export type LockMode = 'exclusive' | 'shared';

export interface LockInfo {
  name: string;
  mode: LockMode;
}

export interface LockOptions {
  mode?: LockMode;
  ifAvailable?: boolean;
  signal?: AbortSignal;
}

export type LockCallback<T> = (lock: LockInfo | null) => T | Promise<T>;

export interface NavigatorLocksShim {
  request<T>(name: string, callback: LockCallback<T>): Promise<T>;
  request<T>(name: string, options: LockOptions, callback: LockCallback<T>): Promise<T>;
}

export function createNavigatorLocksShim(): NavigatorLocksShim {
  // Per-name tail of the wait chain. A new requester awaits this, then runs.
  // Cleared lazily: the last requester clears the entry when it finishes.
  const tails = new Map<string, Promise<unknown>>();

  async function request<T>(
    name: string,
    optionsOrCallback: LockOptions | LockCallback<T>,
    maybeCallback?: LockCallback<T>,
  ): Promise<T> {
    let options: LockOptions;
    let callback: LockCallback<T>;
    if (typeof optionsOrCallback === 'function') {
      options = {};
      callback = optionsOrCallback;
    } else {
      options = optionsOrCallback;
      callback = maybeCallback as LockCallback<T>;
    }

    if (typeof callback !== 'function') {
      throw new TypeError('navigator.locks.request: callback is required');
    }

    const mode: LockMode = options.mode ?? 'exclusive';
    if (mode !== 'exclusive') {
      // Could implement shared mode if hnswered ever needs it; throw loudly
      // so a future caller doesn't silently get exclusive semantics.
      throw new Error(`navigator.locks shim: mode='${mode}' not supported (only 'exclusive')`);
    }

    const prior = tails.get(name);

    if (options.ifAvailable && prior) {
      // Lock is held. Spec says callback receives null and the promise resolves
      // to whatever the callback returns. Do NOT queue.
      return await callback(null);
    }

    // Queue: chain after `prior` (if any), then run our callback under the lock.
    let releaseOurTurn!: () => void;
    const ourTail = new Promise<void>((r) => { releaseOurTurn = r; });

    // Replace the tail with OUR promise BEFORE awaiting prior. This makes any
    // concurrent caller queue behind us, not behind `prior` (FIFO ordering).
    tails.set(name, ourTail);

    // Optional abort: rejects the wait, not the running callback.
    if (options.signal) {
      if (options.signal.aborted) {
        // Resolve our slot so anyone queued behind us proceeds.
        releaseOurTurn();
        if (tails.get(name) === ourTail) tails.delete(name);
        throw options.signal.reason ?? new DOMException('Aborted', 'AbortError');
      }
    }

    let abortHandler: (() => void) | null = null;
    if (options.signal) {
      abortHandler = () => {
        // Mark as aborted; the waiter below checks after `await prior`.
        (ourTail as unknown as { __aborted?: boolean }).__aborted = true;
      };
      options.signal.addEventListener('abort', abortHandler);
    }

    try {
      if (prior) {
        // Errors in prior callbacks must not block the queue — swallow.
        await prior.catch(() => {});
      }
      if ((ourTail as unknown as { __aborted?: boolean }).__aborted) {
        throw options.signal?.reason ?? new DOMException('Aborted', 'AbortError');
      }
      return await callback({ name, mode });
    } finally {
      if (abortHandler && options.signal) {
        options.signal.removeEventListener('abort', abortHandler);
      }
      // Resolve our tail so any queued waiters proceed.
      releaseOurTurn();
      // If no one queued behind us, clear the entry. Use a microtask boundary
      // so a concurrent set in the same tick doesn't get clobbered.
      if (tails.get(name) === ourTail) {
        tails.delete(name);
      }
    }
  }

  return { request: request as NavigatorLocksShim['request'] };
}

/** Install the shim on globalThis.navigator.locks so production code picks it up.
 *
 *  Node 24 exposes `globalThis.navigator` as a read-only getter (cannot be
 *  reassigned), but the navigator object itself is extensible — `locks` is
 *  defined on it directly. If Node ever ships `navigator.locks` natively, this
 *  install path will overwrite it for the test process; the uninstall restores
 *  the prior value (or removes the property if there was none). */
export function installNavigatorLocksShim(shim: NavigatorLocksShim): () => void {
  const g = globalThis as unknown as { navigator?: object };
  const nav = g.navigator;
  if (!nav) {
    // Pre-Node-22 or unusual environment: install a navigator object outright.
    g.navigator = { locks: shim };
    return () => {
      delete g.navigator;
    };
  }
  const hadOwn = Object.prototype.hasOwnProperty.call(nav, 'locks');
  const priorDescriptor = hadOwn ? Object.getOwnPropertyDescriptor(nav, 'locks') : null;
  Object.defineProperty(nav, 'locks', {
    value: shim,
    writable: true,
    configurable: true,
    enumerable: true,
  });
  return () => {
    if (priorDescriptor) {
      Object.defineProperty(nav, 'locks', priorDescriptor);
    } else {
      delete (nav as { locks?: unknown }).locks;
    }
  };
}
