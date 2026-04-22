/**
 * Verifies alarm scheduling fires tick/daily/weekly handlers on the expected cadence
 * using the in-memory chrome.alarms shim's virtual clock.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createChromeShim, installChromeShim } from '../shim/chrome.ts';
import { ALARM, DAY_MS } from '../../src/shared/constants.ts';

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

test('daily and weekly alarms fire on their schedule independently of tick', async () => {
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    const fires: string[] = [];
    shim.alarms.onAlarm.addListener((a) => fires.push(a.name));
    await shim.alarms.create(ALARM.TICK, { periodInMinutes: 5, delayInMinutes: 5 });
    await shim.alarms.create(ALARM.DAILY, { periodInMinutes: 24 * 60, delayInMinutes: 60 });
    await shim.alarms.create(ALARM.WEEKLY, { periodInMinutes: 7 * 24 * 60, delayInMinutes: 24 * 60 });
    // Schedule: weekly first-fire at 1d (delayInMinutes), then every 7d; daily first-fire at 1h, then every 1d.
    // Advance to 6 days: expect tick many, daily ~6, weekly 1.
    await shim.clock.advance(6 * DAY_MS);
    let tickCount = fires.filter((n) => n === ALARM.TICK).length;
    let dailyCount = fires.filter((n) => n === ALARM.DAILY).length;
    let weeklyCount = fires.filter((n) => n === ALARM.WEEKLY).length;
    assert.ok(tickCount > 100, `tick should fire many times over 6 days (got ${tickCount})`);
    assert.equal(dailyCount, 6, `daily should fire 6 times in 6 days (got ${dailyCount})`);
    assert.equal(weeklyCount, 1, `weekly should fire once by day 6 (got ${weeklyCount})`);
    // Advance to day 9: weekly should fire once more (at day 8).
    await shim.clock.advance(3 * DAY_MS);
    tickCount = fires.filter((n) => n === ALARM.TICK).length;
    dailyCount = fires.filter((n) => n === ALARM.DAILY).length;
    weeklyCount = fires.filter((n) => n === ALARM.WEEKLY).length;
    assert.equal(weeklyCount, 2, `weekly should have fired twice by day 9 (got ${weeklyCount})`);
    assert.equal(dailyCount, 9, `daily should have fired 9 times (got ${dailyCount})`);
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

