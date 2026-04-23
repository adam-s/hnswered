/**
 * Replay test for the first-configure scenario.
 *
 * The scenario definition (steps + expected golden names) lives in
 * first-configure.ts and is shared with tests/harness/recorder.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDriver } from '../driver.ts';
import { scenario } from './first-configure.ts';

test('first-configure replays deterministically against tape', async () => {
  const driver = await createDriver({ scenario: scenario.name, mode: 'replay' });
  try {
    await scenario.run(driver);
    // Politeness: first-configure should fit within a reasonable request budget.
    // If a future change blows the budget, we want a loud regression signal.
    assert.ok(
      driver.hnRequests.length <= 200,
      `first-configure made ${driver.hnRequests.length} HN requests, expected <= 200`,
    );
  } finally {
    await driver.uninstall();
  }
});
