/**
 * Scenario: first-time configure of an HN handle.
 *
 * The user installs the extension, opens settings, types `mfiguiere`. The
 * sidepanel sends set-config, which triggers clearPerUserState + a forced
 * runRefresh in the background. runRefresh does syncAuthor (Algolia author
 * feed) + pollComments (Algolia comment feed) — the full first-load surface.
 *
 * Definition only — no node:test registration. Imported by:
 *   - first-configure.test.ts (replay assertions)
 *   - ../recorder.ts (live HN recording)
 */
import type { Driver } from '../driver.ts';

export const scenario = {
  name: 'first-configure',
  user: 'mfiguiere',
  async run(driver: Driver): Promise<void> {
    // 1. Configure the handle. set-config in the background message handler
    //    detects the user change, calls clearPerUserState, kicks off a fire-
    //    and-forget runRefresh().
    await driver.send({ kind: 'set-config', config: { hnUser: scenario.user, tickMinutes: 5 } });

    // 2. Drain the in-flight auto-refresh. force-refresh from the same instant
    //    is throttled (lastForceRefreshAt was just set) and falls through to
    //    the lock-drain path — exclusive navigator.locks.request queues behind
    //    the in-flight refresh and resolves when it releases. This makes the
    //    next snapshot deterministic across record (slow real network) and
    //    replay (fast in-memory tape); snapshotting before the drain races
    //    against in-flight work, producing different results in the two modes.
    await driver.send({ kind: 'force-refresh' });

    await driver.expectGolden('after-refresh');
  },
};
