/**
 * Replay test for the concurrent-refresh scenario.
 *
 * The scenario definition (steps + expected golden + assertion mechanism) lives
 * in concurrent-refresh.ts and is shared with tests/harness/recorder.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDriver } from '../driver.ts';
import { scenario } from './concurrent-refresh.ts';

test('parallel runRefresh calls coalesce into one slot of HN work', async () => {
  const driver = await createDriver({ scenario: scenario.name, mode: 'replay' });
  try {
    await scenario.run(driver);
    // Sanity bound: the scenario should fit within two refresh-flows worth of
    // requests. If it ever creeps past 250, either the production code's
    // refresh-time work grew significantly or coalescing is silently leaking.
    assert.ok(
      driver.hnRequests.length <= 250,
      `concurrent-refresh made ${driver.hnRequests.length} HN requests, expected <= 250`,
    );
  } finally {
    await driver.uninstall();
  }
});
