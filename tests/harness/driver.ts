/**
 * Harness driver — wires the chrome shim, pinned tape clock, and fetch transport,
 * then dynamic-imports the unmodified background module and exposes its public
 * surface (the __hnswered global) for scenario tests.
 *
 * SINGLE-DRIVER-PER-PROCESS INVARIANT
 * ====================================
 * Node's ESM loader caches modules by resolved file path; query-string cache-
 * busters do NOT produce fresh instances of `.ts` files going through the
 * --experimental-strip-types pipeline. This means a second createDriver() call
 * in the same process would re-bind the existing __hnswered global (with
 * listeners still registered against the prior shim that we just uninstalled),
 * silently breaking everything. createDriver() now asserts on this — rely on
 * `node --test`'s default per-file process isolation for separate scenarios,
 * and write multi-driver scenarios as separate test files.
 *
 * Boot order matters:
 *   1. Install fake-timers BEFORE anything reads Date.now (so the background
 *      module's top-level `let lastForceRefreshAt = 0` and any module-load-time
 *      `Date.now()` calls see the pinned time).
 *   2. Install chrome shim with clockSource pointed at the fake-timers clock,
 *      so chrome.alarms scheduling and the poller's age math share one clock.
 *   3. Install the fetch transport in REPLAY mode.
 *   4. Dynamic-import src/background/index.ts. Top-level side effects (alarm
 *      registration, listener registration, refreshBadge) run against the shim.
 *   5. Fire chrome.runtime.onInstalled once (mirrors real SW first-load) and
 *      drain top-level fire-and-forget work via setImmediate before returning.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createChromeShim, installChromeShim, type ChromeShim } from '../shim/chrome.ts';
import { installTapeClock, type TapeClock } from './clock.ts';
import { installFetchTransport, type Tape, type TransportHandle, emptyTape } from './transport.ts';
import { expectGolden } from './snapshot.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = resolve(__dirname, 'fixtures');

export interface BgHandle {
  store: {
    getReplies(): Promise<Record<string, unknown>>;
    getMonitored(): Promise<Record<string, unknown>>;
    getConfig(): Promise<unknown>;
  };
  runTick(): Promise<void>;
  runRefresh(): Promise<void>;
  runDaily(): Promise<void>;
  runWeekly(): Promise<void>;
}

export interface Driver {
  /** Public background surface (the __hnswered global). */
  bg: BgHandle;
  /** Send a SidepanelMessage through chrome.runtime.onMessage. */
  send(message: { kind: string; [k: string]: unknown }): Promise<unknown>;
  /** Snapshot full chrome.storage.local state plus a few derived bits.
   *  Pass to expectGolden / writeGolden. */
  snapshot(): Promise<StorageSnapshot>;
  /** Capture and assert against tests/harness/golden/<scenario>/<step>.json. */
  expectGolden(step: string, snap?: StorageSnapshot): Promise<void>;
  /** Pinned-time clock control. tickAsync also fires due chrome.alarms. */
  clock: {
    now(): number;
    tickAsync(ms: number): Promise<void>;
  };
  /** All HN URLs requested through the transport, in order. */
  hnRequests: string[];
  /** The loaded tape (replay) or the in-progress tape (record). */
  tape: Tape;
  /** Whether the driver is in replay or record mode. */
  mode: 'replay' | 'record';
  uninstall(): Promise<void>;
}

export interface StorageSnapshot {
  config: unknown;
  monitored: unknown;
  replies: unknown;
  timestamps: {
    lastTick: number | null;
    lastUserSync: number | null;
    lastDailyScan: number | null;
    lastWeeklyScan: number | null;
  };
  // hnRequestCount is intentionally NOT in the snapshot — real-network retries
  // during recording inflate the count vs replay (zero-latency, zero retries),
  // making goldens unstable. Use `driver.hnRequests.length` directly in test
  // assertions where a request budget needs to be enforced.
}

export interface CreateDriverOptions {
  scenario: string;
  /** Required in record mode; loaded from disk in replay mode. */
  user?: string;
  mode: 'replay' | 'record';
  /** Override the tape file path. Defaults to tests/harness/fixtures/<scenario>/tape.json. */
  tapePath?: string;
  /** Record mode only: tape's recordedAt anchor. Defaults to Date.now() at install time. */
  recordedAt?: number;
}

export async function createDriver(opts: CreateDriverOptions): Promise<Driver> {
  // SINGLE-DRIVER-PER-PROCESS check. See header comment for rationale.
  if ((globalThis as { __hnswered?: unknown }).__hnswered) {
    throw new Error(
      'createDriver: __hnswered global already exists — second createDriver in one process. ' +
      'Node ESM does not re-evaluate cached modules; query-string cache-busters do not work for ' +
      '.ts files. Run each scenario in its own test file (node --test spawns a child per file) ' +
      'or split multi-driver scenarios across processes.',
    );
  }

  const tapePath = opts.tapePath ?? resolve(FIXTURES_ROOT, opts.scenario, 'tape.json');

  let tape: Tape;
  if (opts.mode === 'replay') {
    tape = JSON.parse(readFileSync(tapePath, 'utf-8'));
  } else {
    if (!opts.user) throw new Error('record mode requires opts.user');
    // Capture real now BEFORE installing the fake clock.
    const realNow = Date.now();
    tape = emptyTape(opts.scenario, opts.user, opts.recordedAt ?? realNow);
  }

  // Step 1: pin Date.now via @sinonjs/fake-timers.
  const tapeClock: TapeClock = installTapeClock(tape.recordedAt);

  // Step 2: chrome shim, sharing the same clock.
  const shim: ChromeShim = createChromeShim({ clockSource: tapeClock.now });
  const uninstallShim = installChromeShim(shim);

  // Step 3: fetch transport.
  let transport: TransportHandle;
  if (opts.mode === 'replay') {
    transport = installFetchTransport({ mode: 'replay', tape });
  } else {
    transport = installFetchTransport({ mode: 'record', tape });
  }

  // Step 4: dynamic import of unmodified background module.
  const bgUrl = new URL('../../src/background/index.ts', import.meta.url).href;
  await import(bgUrl);

  // Step 5: mirror real SW startup. The production module registers an
  // onInstalled listener that runs ensureAlarms + refreshBadge; without firing
  // it, scenarios that depend on alarm registration would silently see no
  // alarms even though chrome.alarms.create was wired in the production code.
  await shim.fireOnInstalled();

  // Step 6: drain any remaining fire-and-forget work from module load.
  // setImmediate runs after all currently-queued I/O and microtasks, so this
  // is a stronger drain than `await Promise.resolve()`.
  await new Promise((r) => setImmediate(r));

  const bgHandle = (globalThis as unknown as { __hnswered: BgHandle }).__hnswered;
  if (!bgHandle) throw new Error('background module did not expose __hnswered global');

  async function snapshot(): Promise<StorageSnapshot> {
    const all = (await shim.storage.local.get(null)) as Record<string, unknown>;
    return {
      config: all.config ?? null,
      monitored: all.monitored ?? {},
      replies: all.replies ?? {},
      timestamps: {
        lastTick: (all.lastTick as number | undefined) ?? null,
        lastUserSync: (all.lastUserSync as number | undefined) ?? null,
        lastDailyScan: (all.lastDailyScan as number | undefined) ?? null,
        lastWeeklyScan: (all.lastWeeklyScan as number | undefined) ?? null,
      },
    };
  }

  return {
    bg: bgHandle,
    async send(message) {
      return shim.dispatchMessage(message);
    },
    snapshot,
    async expectGolden(step, snap) {
      // In record mode, expectGolden is a no-op. The recorder's job is to write
      // the tape; goldens are seeded later by HARNESS_UPDATE_GOLDEN=1 pnpm
      // harness:replay so they reflect what replay actually produces (truncated
      // text and all). Auto-writing during record would capture untruncated
      // text and diverge from replay output.
      if (opts.mode === 'record') {
        // Still take the snapshot — exercises the snapshot code path during
        // recording, catching any errors before they bite at golden-seeding.
        await (snap ? Promise.resolve(snap) : snapshot());
        return;
      }
      const s = snap ?? (await snapshot());
      expectGolden(opts.scenario, step, s);
    },
    clock: {
      now: () => tapeClock.now(),
      tickAsync: async (ms: number) => {
        await tapeClock.tickAsync(ms);
        // setImmediate after the time advance lets any awaits that observe the
        // new Date.now value run their continuations before we fire alarms.
        // A single `await Promise.resolve()` only drains one microtask turn,
        // not the chained-await sequences typical in the poller.
        //
        // KNOWN LIMITATION: setImmediate cannot drain real-setTimeout sleeps.
        // The production HN client uses real `setTimeout(r, 50)` between
        // requests (see hn-client.ts) and clock.ts deliberately does not fake
        // setTimeout. If pumpAlarms() fires an alarm whose handler eventually
        // hits one of those sleeps (e.g., an alarm-driven runTick that calls
        // fetchItems), the storage writes from that work will NOT have landed
        // when this tickAsync resolves. Snapshots taken immediately after a
        // clock advance past an alarm boundary may read stale state.
        //
        // Workaround for scenarios that need to observe alarm-triggered work:
        // after `clock.tickAsync`, await `bg.runTick()` — singleFlight will
        // coalesce with the in-flight alarm-driven tick and resolve only when
        // that work completes.
        await new Promise((r) => setImmediate(r));
        await shim.clock.pumpAlarms();
        await new Promise((r) => setImmediate(r));
      },
    },
    get hnRequests() {
      return transport.hnRequests;
    },
    tape,
    mode: opts.mode,
    async uninstall() {
      transport.uninstall();
      uninstallShim();
      tapeClock.uninstall();
      // Clear __hnswered so the single-driver-per-process check at the top of
      // the next createDriver() call gives a clean error if someone tries to
      // use this driver in a multi-driver pattern.
      delete (globalThis as { __hnswered?: unknown }).__hnswered;
    },
  };
}
