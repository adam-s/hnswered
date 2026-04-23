/**
 * Tiny in-memory chrome.* shim for unit tests.
 * Implements only what our code uses: storage.local + alarms with virtual time.
 *
 * Two clock modes:
 *   - Internal (default): shim owns `now` and advances it on `clock.advance(ms)`.
 *     Used by tests/unit/* — unchanged from original behavior.
 *   - External (opt-in): pass `{ clockSource: () => number }` to createChromeShim.
 *     `clock.now()` reads the external source. `clock.advance/set` become
 *     no-ops on time itself; the harness drives time via @sinonjs/fake-timers
 *     and calls `clock.pumpAlarms()` to fire any due alarms.
 *
 * Also stubs the chrome.runtime/sidePanel/action.onClicked surfaces touched at
 * background module-load time so the harness can `await import` index.ts cleanly.
 * Existing unit tests don't touch these surfaces, so they remain non-breaking.
 */

interface AlarmRecord {
  name: string;
  periodInMinutes?: number;
  scheduledTime: number;
}

export interface FakeClock {
  now(): number;
  advance(ms: number): Promise<void>;
  set(ms: number): Promise<void>;
  /** Fire any alarms whose scheduledTime <= clock.now(). Idempotent. */
  pumpAlarms(): Promise<void>;
}

type MessageListener = (
  message: unknown,
  sender: { url?: string },
  sendResponse: (response?: unknown) => void,
) => boolean | undefined | void;

export interface ChromeShim {
  storage: {
    local: chrome.storage.StorageArea;
    onChanged: { addListener(fn: (changes: unknown, area: string) => void): void; removeListener(fn: (changes: unknown, area: string) => void): void };
  };
  alarms: {
    create(name: string, info: { periodInMinutes?: number; delayInMinutes?: number; when?: number }): Promise<void>;
    get(name: string): Promise<AlarmRecord | undefined>;
    getAll(): Promise<AlarmRecord[]>;
    clear(name: string): Promise<boolean>;
    onAlarm: { addListener(fn: (alarm: AlarmRecord) => void): void };
  };
  action: {
    setBadgeText(info: { text: string }): Promise<void>;
    setBadgeBackgroundColor(info: { color: string }): Promise<void>;
    setBadgeTextColor(info: { color: string }): Promise<void>;
    getBadge(): { text: string };
    onClicked: { addListener(fn: (tab: { windowId?: number }) => void): void };
  };
  runtime: {
    lastError: null;
    onInstalled: { addListener(fn: () => void): void };
    onStartup: { addListener(fn: () => void): void };
    onMessage: { addListener(fn: MessageListener): void };
  };
  sidePanel: {
    open(opts: { windowId: number }): Promise<void>;
  };
  clock: FakeClock;
  /** Harness-side message dispatcher — invokes registered onMessage listeners
   *  and resolves with sendResponse's argument (or undefined). If a listener
   *  returns true (promising async response) but never calls sendResponse,
   *  the promise rejects after `timeoutMs` (default 30000) instead of hanging. */
  dispatchMessage(message: unknown, opts?: { timeoutMs?: number }): Promise<unknown>;
  /** Harness-side hook to fire onInstalled / onStartup once each (background's lifecycle). */
  fireOnInstalled(): Promise<void>;
  fireOnStartup(): Promise<void>;
}

export interface CreateChromeShimOptions {
  /** When provided, clock.now() reads from here. Use to bridge to @sinonjs/fake-timers. */
  clockSource?: () => number;
}

export function createChromeShim(
  startTsOrOptions: number | CreateChromeShimOptions = 1_700_000_000_000,
  maybeOptions?: CreateChromeShimOptions,
): ChromeShim {
  // Backward-compatible signature: createChromeShim() | createChromeShim(startTs) | createChromeShim({ clockSource })
  const startTs = typeof startTsOrOptions === 'number' ? startTsOrOptions : 1_700_000_000_000;
  const options = typeof startTsOrOptions === 'object' ? startTsOrOptions : (maybeOptions ?? {});
  const externalClock = options.clockSource;

  let internalNow = startTs;
  const readNow = () => (externalClock ? externalClock() : internalNow);

  // Iteration cap to prevent CPU bombs from long clock jumps. A test that
  // advances by a week with a 1-minute period alarm would otherwise fire 10080
  // times synchronously. Real chrome.alarms coalesces missed periodic fires
  // into a single delivery anyway. 10000 is generous for any plausible
  // scenario and small enough to terminate in milliseconds if we hit it.
  const MAX_PUMP_ITERATIONS = 10_000;

  async function pumpAlarmsTo(target: number) {
    let iter = 0;
    while (iter++ < MAX_PUMP_ITERATIONS) {
      let next: AlarmRecord | null = null;
      for (const a of alarms.values()) {
        if (a.scheduledTime <= target && (!next || a.scheduledTime < next.scheduledTime)) next = a;
      }
      if (!next) break;
      // Internal-mode only: advance `now` to the alarm time as we fire each one.
      // External-mode: clock is already at `target`; just fire.
      if (!externalClock) internalNow = next.scheduledTime;
      // Snapshot the alarm record BEFORE re-scheduling. Chrome's onAlarm
      // listeners receive the scheduledTime of the fire that just happened,
      // not the next scheduled fire time. Spreading after the period bump
      // delivered the wrong value — pre-existing bug in the original advanceTo
      // loop, propagated to pumpAlarmsTo when the external-clock path was
      // added; existing unit tests only count fires by name so it was silent.
      const fired: AlarmRecord = { ...next };
      if (next.periodInMinutes && next.periodInMinutes > 0) {
        next.scheduledTime += next.periodInMinutes * 60_000;
      } else {
        alarms.delete(next.name);
      }
      for (const fn of alarmListeners) fn(fired);
    }
    if (iter >= MAX_PUMP_ITERATIONS) {
      throw new Error(
        `pumpAlarmsTo: exceeded ${MAX_PUMP_ITERATIONS} iterations advancing to ${target}. ` +
        `Likely a long clock jump combined with a short-period alarm. Real chrome.alarms ` +
        `coalesces missed fires into a single delivery; consider whether the scenario ` +
        `actually needs the intermediate fires.`,
      );
    }
    if (!externalClock) internalNow = target;
  }

  const clock: FakeClock = {
    now: readNow,
    async advance(ms) {
      // External clock: caller already advanced time elsewhere; just pump.
      // Internal clock: advance and pump.
      const target = externalClock ? readNow() : internalNow + ms;
      await pumpAlarmsTo(target);
    },
    async set(ms) {
      if (externalClock) {
        // Caller controls time; just pump to current.
        await pumpAlarmsTo(readNow());
      } else {
        await pumpAlarmsTo(ms);
      }
    },
    async pumpAlarms() {
      await pumpAlarmsTo(readNow());
    },
  };

  const store: Record<string, unknown> = {};
  const changeListeners: Array<(changes: unknown, area: string) => void> = [];

  const storageLocal: chrome.storage.StorageArea = {
    async get(keys?: string | string[] | Record<string, unknown> | null) {
      const result: Record<string, unknown> = {};
      const want =
        keys == null
          ? Object.keys(store)
          : typeof keys === 'string'
          ? [keys]
          : Array.isArray(keys)
          ? keys
          : Object.keys(keys);
      for (const k of want) if (k in store) result[k] = store[k];
      return result;
    },
    async set(items: Record<string, unknown>) {
      const changes: Record<string, { oldValue?: unknown; newValue: unknown }> = {};
      for (const [k, v] of Object.entries(items)) {
        changes[k] = { oldValue: store[k], newValue: v };
        store[k] = v;
      }
      for (const fn of changeListeners) fn(changes, 'local');
    },
    async remove(keys: string | string[]) {
      const list = Array.isArray(keys) ? keys : [keys];
      const changes: Record<string, { oldValue?: unknown; newValue: undefined }> = {};
      for (const k of list) {
        if (k in store) {
          changes[k] = { oldValue: store[k], newValue: undefined };
          delete store[k];
        }
      }
      for (const fn of changeListeners) fn(changes, 'local');
    },
    async clear() {
      for (const k of Object.keys(store)) delete store[k];
    },
    async getBytesInUse() {
      return 0;
    },
  } as unknown as chrome.storage.StorageArea;

  const alarms = new Map<string, AlarmRecord>();
  const alarmListeners: Array<(alarm: AlarmRecord) => void> = [];

  let badgeText = '';
  let badgeBg = '';
  let badgeFg = '';

  const messageListeners: MessageListener[] = [];
  const onInstalledListeners: Array<() => void> = [];
  const onStartupListeners: Array<() => void> = [];
  const onClickedListeners: Array<(tab: { windowId?: number }) => void> = [];

  const shim: ChromeShim = {
    storage: {
      local: storageLocal,
      onChanged: {
        addListener: (fn) => changeListeners.push(fn),
        removeListener: (fn) => {
          const i = changeListeners.indexOf(fn);
          if (i >= 0) changeListeners.splice(i, 1);
        },
      },
    },
    alarms: {
      async create(name, info) {
        const delayMs = (info.delayInMinutes ?? info.periodInMinutes ?? 0) * 60_000;
        const when = info.when ?? readNow() + delayMs;
        alarms.set(name, {
          name,
          periodInMinutes: info.periodInMinutes,
          scheduledTime: when,
        });
      },
      async get(name) {
        const a = alarms.get(name);
        return a ? { ...a } : undefined;
      },
      async getAll() {
        return Array.from(alarms.values(), (a) => ({ ...a }));
      },
      async clear(name) {
        return alarms.delete(name);
      },
      onAlarm: {
        addListener: (fn) => alarmListeners.push(fn),
      },
    },
    action: {
      async setBadgeText({ text }) {
        badgeText = text;
      },
      async setBadgeBackgroundColor({ color }) {
        badgeBg = color;
      },
      async setBadgeTextColor({ color }) {
        badgeFg = color;
      },
      getBadge() {
        return { text: badgeText };
      },
      onClicked: {
        addListener: (fn) => onClickedListeners.push(fn),
      },
    },
    runtime: {
      lastError: null,
      onInstalled: { addListener: (fn) => onInstalledListeners.push(fn) },
      onStartup: { addListener: (fn) => onStartupListeners.push(fn) },
      onMessage: { addListener: (fn) => messageListeners.push(fn) },
    },
    sidePanel: {
      async open() {
        // No-op; harness is headless.
      },
    },
    clock,
    async dispatchMessage(message, opts) {
      // Mirror chrome.runtime.onMessage contract: a listener that returns `true`
      // is responsible for calling sendResponse asynchronously. The promise
      // resolves with whatever the first listener passes to sendResponse.
      //
      // Timeout: if a listener returns `true` but never calls sendResponse
      // (a real bug class — the message handler in index.ts has a try/catch
      // but a synchronous throw before the inner async IIFE attaches .then
      // would skip it), the promise would otherwise hang forever, deadlocking
      // the scenario. node:test's per-test timeout would eventually catch it
      // but with no useful diagnostic. 30s default; configurable per call.
      const timeoutMs = opts?.timeoutMs ?? 30_000;
      return new Promise((resolve, reject) => {
        let handled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const settle = (action: () => void) => {
          if (handled) return;
          handled = true;
          if (timer) clearTimeout(timer);
          action();
        };
        const respond = (value?: unknown) => settle(() => resolve(value));
        let willRespondAsync = false;
        for (const fn of messageListeners) {
          const ret = fn(message, { url: 'harness://sidepanel' }, respond);
          if (ret === true) willRespondAsync = true;
        }
        if (!willRespondAsync) {
          settle(() => resolve(undefined));
          return;
        }
        // Synchronous-respond path: a listener that returns `true` MAY also have
        // called sendResponse synchronously inside its body before returning
        // (e.g. via an async IIFE that ran to completion without awaiting).
        // In that case `handled` is already true here. Scheduling setTimeout
        // anyway would leak a real-wall 30s timer that keeps the Node process
        // alive after node --test's per-file assertions complete, blocking
        // process exit. Check `handled` first.
        if (handled) return;
        timer = setTimeout(() => {
          settle(() => reject(new Error(
            `dispatchMessage: listener returned true (promising async response) but ` +
            `never called sendResponse within ${timeoutMs}ms for message ` +
            `${JSON.stringify(message).slice(0, 100)}. Likely a forgotten respond() ` +
            `call in the background message handler.`,
          )));
        }, timeoutMs);
      });
    },
    async fireOnInstalled() {
      for (const fn of onInstalledListeners) await fn();
    },
    async fireOnStartup() {
      for (const fn of onStartupListeners) await fn();
    },
  };
  void badgeBg;
  void badgeFg;
  void onClickedListeners;
  return shim;
}

/** Install the shim on globalThis so production code using `chrome.*` picks it up. */
export function installChromeShim(shim: ChromeShim): () => void {
  const g = globalThis as Record<string, unknown>;
  const prev = g.chrome;
  g.chrome = {
    storage: shim.storage,
    alarms: shim.alarms,
    action: shim.action,
    runtime: shim.runtime,
    sidePanel: shim.sidePanel,
  };
  return () => {
    g.chrome = prev;
  };
}
