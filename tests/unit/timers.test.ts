/**
 * Verifies the single tick alarm fires on the expected cadence using the
 * in-memory chrome.alarms shim's virtual clock. Daily/weekly alarms no longer
 * exist — the one-alarm design with internal cadence gates supersedes them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createChromeShim, installChromeShim } from '../shim/chrome.ts';
import {
  ALARM,
  AUTHOR_SYNC_MS,
  MAX_TICK_MINUTES,
  OVERLAP_MS,
  assertCadenceInvariant,
} from '../../src/shared/constants.ts';

test('alarm fires at expected cadence and reschedules', async () => {
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    let tickCount = 0;
    shim.alarms.onAlarm.addListener((a) => {
      if (a.name === ALARM.TICK) tickCount++;
    });
    await shim.alarms.create(ALARM.TICK, { periodInMinutes: 5, delayInMinutes: 5 });
    await shim.clock.advance(4 * 60_000);
    assert.equal(tickCount, 0, 'should not fire before 5min');
    await shim.clock.advance(1 * 60_000);
    assert.equal(tickCount, 1, 'fires at 5min');
    await shim.clock.advance(10 * 60_000);
    assert.equal(tickCount, 3, 'fires twice more at 10/15min');
  } finally {
    off();
  }
});

test('updating tick period replaces the alarm with new cadence', async () => {
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    let count = 0;
    shim.alarms.onAlarm.addListener(() => count++);
    await shim.alarms.create(ALARM.TICK, { periodInMinutes: 5, delayInMinutes: 5 });
    await shim.clock.advance(6 * 60_000);
    assert.equal(count, 1);
    await shim.alarms.clear(ALARM.TICK);
    await shim.alarms.create(ALARM.TICK, { periodInMinutes: 1, delayInMinutes: 1 });
    await shim.clock.advance(3 * 60_000);
    assert.equal(count, 4, 'three extra fires at new 1-min cadence');
  } finally {
    off();
  }
});

test('REGRESSION HIGH: cadence invariant is actually enforced (mutation M2)', () => {
  // The shipped constants must satisfy OVERLAP_MS >= AUTHOR_SYNC_MS +
  // MAX_TICK_MINUTES*60s. A silent violation would re-introduce the
  // "reply on a freshly-authored comment ages out before author-sync
  // discovers the parent" miss path. Mutating any of the three constants
  // to an illegal combination must trip the invariant.
  assert.doesNotThrow(
    () => assertCadenceInvariant(OVERLAP_MS, AUTHOR_SYNC_MS, MAX_TICK_MINUTES),
    'shipped constants must satisfy the invariant',
  );
  // Legal edge: overlap exactly equals required — must pass.
  assert.doesNotThrow(
    () => assertCadenceInvariant(10 * 60_000 + 5 * 60_000, 10 * 60_000, 5),
    'overlap = authorSync + tick × 60s exactly is legal',
  );
  // Illegal: overlap one millisecond short.
  assert.throws(
    () => assertCadenceInvariant(10 * 60_000 + 5 * 60_000 - 1, 10 * 60_000, 5),
    /cadence invariant violated/,
    '1ms under the requirement must throw',
  );
  // Illegal: zero overlap.
  assert.throws(
    () => assertCadenceInvariant(0, AUTHOR_SYNC_MS, MAX_TICK_MINUTES),
    /cadence invariant violated/,
    'zero overlap must throw',
  );
});

