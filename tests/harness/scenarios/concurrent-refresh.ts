/**
 * Scenario: parallel runRefresh calls must coalesce into one slot of HN work.
 *
 * This is the regression test for the upcoming TODO #1 (Web Locks API)
 * refactor. Today's coalescing is implemented by the hand-rolled `singleFlight`
 * map + `runRefresh`'s forward-reference slot-swap dance in
 * src/background/index.ts. The Web Locks refactor will replace that machinery
 * with `navigator.locks.request('tick', { mode: 'exclusive' }, ...)`.
 *
 * THE TAPE IS THE ASSERTION.
 *
 * The recorded tape contains exactly TWO refresh-flows worth of HN traffic:
 *   1. One auto-refresh kicked off by the user-change branch in set-config.
 *   2. One refresh from the parallel pair below — *coalesced into a single
 *      slot of work* by singleFlight (or, post-refactor, by the Web Lock).
 *
 * If coalescing ever breaks and the parallel pair actually executed two
 * separate refreshes, the second one would try to fetch
 * `/v0/user/<handle>.json` a third time. The transport's strict per-URL cursor
 * (transport.ts) throws TapeMiss on overrun, so the test fails loudly with a
 * clear "cursor exceeds N recorded calls" error instead of silently re-serving.
 *
 * What the test does NOT cover:
 *   - Multi-driver-per-process scenarios (chrome shim + dynamic import are
 *     single-driver per process, by design — see driver.ts header). The Web
 *     Locks refactor's bonus benefit of serializing across multiple sidepanel
 *     contexts can't be exercised here without process orchestration.
 */
import type { Driver } from '../driver.ts';

// Mirrors src/background/index.ts MIN_REFRESH_INTERVAL_MS. Hardcoded here so
// the scenario stays a black-box test of behavior, not an import of internals.
const MIN_REFRESH_INTERVAL_MS = 10_000;

export const scenario = {
  name: 'concurrent-refresh',
  user: 'mfiguiere',
  async run(driver: Driver): Promise<void> {
    // Step 1: configure handle. set-config detects the user change, calls
    // clearPerUserState, kicks off `void runRefresh()` (fire-and-forget).
    await driver.send({ kind: 'set-config', config: { hnUser: scenario.user, tickMinutes: 5 } });

    // Step 2: drain the auto-refresh. force-refresh from this same instant is
    // throttled (lastForceRefreshAt was just set by the auto-refresh), falls
    // through to runTick → singleFlight returns the in-flight slot → both
    // promises resolve when the original refresh completes.
    await driver.send({ kind: 'force-refresh' });

    // Step 3: advance past the throttle window so the next refresh path does
    // real work (otherwise it'd just throttle and coalesce trivially).
    await driver.clock.tickAsync(MIN_REFRESH_INTERVAL_MS + 1_000);

    // Step 4: THE TEST. Fire two parallel runRefresh calls.
    //
    // JS execution order under V8:
    //   - Call A starts. Body runs synchronously up to its first internal
    //     await: reads Date.now, computes sinceLastMs > threshold (unthrottled),
    //     sets lastForceRefreshAt = now, seizes inFlight.tick = slot, returns
    //     slot promise. Then control yields at the slot's first await.
    //   - Call B starts. Body runs synchronously: reads the just-set
    //     lastForceRefreshAt, computes sinceLastMs = 0 (throttled), enters
    //     `await runTick()` → singleFlight returns inFlight.tick → both await
    //     the same slot.
    //
    // Tape captures only call A's traffic. If call B somehow executed
    // separately, its `/v0/user/<handle>.json` fetch would overrun the tape's
    // 2 recorded entries → TapeMiss → test fails with a clear diagnostic.
    await Promise.all([driver.bg.runRefresh(), driver.bg.runRefresh()]);

    await driver.expectGolden('after-coalesced-refresh');
  },
};
