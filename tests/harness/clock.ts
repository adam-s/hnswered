/**
 * Pinned clock for tape replay, wrapping @sinonjs/fake-timers.
 *
 * Anchors Date.now() to the tape's recordedAt timestamp so the poller's age-bucket
 * logic (FAST_MAX_AGE_MS, DROP_AGE_MS, USER_SYNC_MIN_INTERVAL_MS, etc.) returns
 * the same answers in CI today as it did the day the tape was recorded — and as
 * it will six months from now. The VCR+Timecop / vcrpy+freezegun pattern, ported
 * to JS via the de facto sinon timers.
 *
 * Why we ONLY fake Date (not setTimeout/setInterval/queueMicrotask):
 *
 *   - setTimeout: the production HN client uses setTimeout for sleep(50) between
 *     requests AND for the AbortController fetch timeout. Faking them deadlocks
 *     the request loop — sleep never resolves, abort timer never fires. We want
 *     real timers for the production code, pinned wall-clock for the bucket math.
 *
 *   - queueMicrotask: faking microtasks hangs fetch interceptors that drive their
 *     state machine via microtasks (MSW v2 famously, see MSW#1830). Production
 *     background code uses await chains heavily; faking microtasks invites the
 *     same class of bug. Sinon docs explicitly call this out.
 *
 * Cooldown/throttle assertions still work because they read Date.now(), which IS
 * faked. Retry-backoff *timing* can't be asserted under this setup — assert that
 * a retry happened (via the request log) instead.
 *
 * Time advancement: call setSystemTime(t) to jump forward. Then call
 * shim.clock.pumpAlarms() to fire any chrome.alarms whose scheduledTime now
 * elapsed. The driver's clock.tickAsync wraps both.
 */
import FakeTimers from '@sinonjs/fake-timers';

export interface TapeClock {
  /** Current pinned time in ms. Same value Date.now() now returns. */
  now(): number;
  /** Advance pinned wall time by `ms`. Real setTimeout/setInterval are NOT faked,
   *  so any scheduled timers continue to fire in real wall time independent of
   *  this advance. The driver pairs this with shim.clock.pumpAlarms() to fire
   *  chrome.alarms whose scheduledTime now falls in the past. */
  tickAsync(ms: number): Promise<void>;
  /** Jump to an absolute time. */
  setSystemTime(ms: number): void;
  uninstall(): void;
}

export function installTapeClock(recordedAtMs: number): TapeClock {
  const clock = FakeTimers.install({
    now: recordedAtMs,
    toFake: ['Date'],
    shouldAdvanceTime: false,
  });
  return {
    now: () => clock.now,
    tickAsync: async (ms) => {
      // setSystemTime advances Date.now without trying to fire any (un-faked)
      // timers. tickAsync would also try to drain the timer queue, which is empty
      // in our setup; setSystemTime is the simpler primitive.
      clock.setSystemTime(clock.now + ms);
      // Yield once so any awaits that just observed the time change get to run.
      await Promise.resolve();
    },
    setSystemTime: (ms) => {
      clock.setSystemTime(ms);
    },
    uninstall: () => {
      clock.uninstall();
    },
  };
}
