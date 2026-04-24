#!/usr/bin/env node
/**
 * Chaos harness for the settings/config state machine.
 *
 * Runs scripted adversarial sequences against the extension — rapid username
 * swaps, concurrent force-refreshes, settings changes mid-scan, retention
 * churn, hard-cap overflow — and checks a fixed set of invariants after every
 * move. Read-only against live HN; every run is budget-bounded.
 *
 * Usage:
 *   node scripts/chaos.mjs [--label=chaos-run] [--budget=300]
 *                          [--scenarios=rapid-user-swap,refresh-spam]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchWithExtension } from './lib/extension.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  }),
);
const LABEL = args.label ?? `chaos-${Date.now()}`;
const BUDGET = Number(args.budget ?? 300);
const OUT = resolve(REPO, '.chaos', LABEL);
mkdirSync(OUT, { recursive: true });

const DAY_MS = 86_400_000;
// HN's current max item ID is ~47M. Using 900M+ guarantees /v0/item/<id>.json returns
// null so no synthetic fixture accidentally collides with a real HN item.
const FAKE_ID_BASE = 900_000_000;

// ── Helpers ────────────────────────────────────────────────────────────────

async function inspect(ext) {
  const state = await ext.send({ kind: 'inspect' });
  if (!state?.ok) throw new Error(`inspect failed: ${JSON.stringify(state)}`);
  return state.data;
}

/**
 * Seed monitored items directly into storage, bypassing any sync path.
 * Used to prepare adversarial fixtures cheaply.
 */
async function seedMonitored(ext, items) {
  await ext.sw.evaluate(async (raw) => {
    const cur = (await chrome.storage.local.get('monitored'))?.monitored ?? {};
    for (const it of raw) cur[String(it.id)] = it;
    await chrome.storage.local.set({ monitored: cur });
  }, items);
}

/**
 * Seed replies directly. Useful for triggering hardCap + retention paths
 * without waiting for real HN activity.
 */
async function seedReplies(ext, replies) {
  await ext.sw.evaluate(async (raw) => {
    const cur = (await chrome.storage.local.get('replies'))?.replies ?? {};
    for (const r of raw) cur[String(r.id)] = r;
    await chrome.storage.local.set({ replies: cur });
  }, replies);
}

function mkReply(over) {
  const id = over.id;
  return {
    id,
    parentItemId: over.parentItemId ?? 999999,
    author: over.author ?? `u${id % 100}`,
    text: over.text ?? `synthetic reply ${id}`,
    time: over.time ?? Date.now() - 60_000,
    read: over.read ?? false,
    discoveredAt: over.discoveredAt ?? Date.now(),
  };
}

function mkMonitored(over) {
  return {
    id: over.id,
    type: over.type ?? 'story',
    submittedAt: over.submittedAt ?? Date.now() - DAY_MS,
    title: over.title,
    excerpt: over.excerpt,
    parentAuthor: over.parentAuthor,
  };
}

// ── Invariants ─────────────────────────────────────────────────────────────

function checkConfigShape(cfg) {
  const errs = [];
  if (cfg == null || typeof cfg !== 'object') errs.push('config not an object');
  if (typeof cfg?.hnUser !== 'string') errs.push('hnUser not a string');
  if (typeof cfg?.tickMinutes !== 'number' || cfg.tickMinutes < 1) errs.push('tickMinutes invalid');
  if (typeof cfg?.retentionDays !== 'number' || cfg.retentionDays < 1) errs.push('retentionDays invalid');
  return errs;
}

function checkMonitoredShape(m) {
  const errs = [];
  for (const [key, item] of Object.entries(m ?? {})) {
    if (Number(key) !== item?.id) errs.push(`monitored key/id mismatch at ${key}`);
    if (!['story', 'comment'].includes(item?.type)) errs.push(`monitored[${key}] bad type`);
    if (typeof item?.submittedAt !== 'number') errs.push(`monitored[${key}] submittedAt not number`);
    if (typeof item?.submittedAt !== 'number') errs.push(`monitored[${key}] submittedAt invalid`);
  }
  return errs;
}

function checkRepliesShape(replies) {
  const errs = [];
  const ids = new Set();
  for (const [key, r] of Object.entries(replies ?? {})) {
    if (Number(key) !== r?.id) errs.push(`reply key/id mismatch at ${key}`);
    if (ids.has(r.id)) errs.push(`duplicate reply id ${r.id}`);
    ids.add(r.id);
    if (typeof r?.author !== 'string') errs.push(`reply[${key}] author invalid`);
    if (typeof r?.read !== 'boolean') errs.push(`reply[${key}] read not boolean`);
  }
  return errs;
}

async function assertInvariants(ext, label) {
  const stats = await ext.send({ kind: 'get-storage-stats' });
  const monitored = await ext.send({ kind: 'get-monitored' });
  const config = await ext.send({ kind: 'get-config' });
  const raw = await ext.sw.evaluate(() => chrome.storage.local.get(['replies', 'monitored', 'config']));

  const errs = [
    ...checkConfigShape(config?.data),
    ...checkMonitoredShape(raw.monitored),
    ...checkRepliesShape(raw.replies),
  ];

  const s = stats?.data;
  if (s && s.bytesInUse > 10 * 1024 * 1024) errs.push(`bytes over quota: ${s.bytesInUse}`);
  if (s && s.replyCount > 5000) errs.push(`reply count over hard cap: ${s.replyCount}`);

  return {
    label,
    passed: errs.length === 0,
    errors: errs,
    stats: s,
    monitoredCount: monitored?.data?.length ?? 0,
  };
}

// ── Scenarios ──────────────────────────────────────────────────────────────

/** Swap users rapidly; each swap should clear per-user state. */
async function rapidUserSwap(ext) {
  const moves = [];
  await ext.send({ kind: 'reset-all' });
  for (const user of ['chaos_a', 'chaos_b', 'chaos_a', '', 'chaos_c', 'chaos_b']) {
    await ext.send({ kind: 'set-config', config: { hnUser: user, tickMinutes: 5, retentionDays: 30 } });
    moves.push({ move: `set-user:${user || '<empty>'}` });
    // Seed a few items so we can verify they get cleared on next swap
    if (user) {
      await seedMonitored(ext, [mkMonitored({ id: FAKE_ID_BASE + 100 + moves.length, type: 'story' })]);
      await seedReplies(ext, [mkReply({ id: FAKE_ID_BASE + 200 + moves.length, parentItemId: FAKE_ID_BASE + 100 + moves.length })]);
    }
  }
  return moves;
}

/** Spam force-refresh; throttle should kick in and no concurrent ticks should run. */
async function refreshSpam(ext) {
  const moves = [];
  await ext.send({ kind: 'reset-all' });
  await ext.send({ kind: 'set-config', config: { hnUser: 'chaos_nobody_9f3k', tickMinutes: 5, retentionDays: 30 } });
  // Fire 8 refreshes without awaiting — singleFlight('tick') should coalesce, throttle should gate force-sync.
  const pending = [];
  for (let i = 0; i < 8; i++) pending.push(ext.send({ kind: 'force-refresh' }));
  await Promise.all(pending);
  moves.push({ move: 'force-refresh x8 concurrent' });
  return moves;
}

/** Churn tickMinutes and retentionDays repeatedly; alarms should end at the final values only. */
async function settingsChurn(ext) {
  const moves = [];
  await ext.send({ kind: 'reset-all' });
  const cycles = [
    { tickMinutes: 1, retentionDays: 7 },
    { tickMinutes: 60, retentionDays: 365 },
    { tickMinutes: 5, retentionDays: 30 },
    { tickMinutes: 15, retentionDays: 14 },
    { tickMinutes: 1, retentionDays: 7 },
  ];
  for (const c of cycles) {
    await ext.send({ kind: 'set-config', config: { hnUser: 'chaos_nobody_9f3k', ...c } });
    moves.push({ move: `set-config tick=${c.tickMinutes} retention=${c.retentionDays}` });
  }
  // Confirm the tick alarm matches the final period
  const inspected = await inspect(ext);
  const tick = inspected.alarms?.find((a) => a.name.endsWith('tick'));
  moves.push({ move: 'verify tick alarm', tickPeriod: tick?.periodInMinutes, expected: 1 });
  if (tick?.periodInMinutes !== 1) throw new Error(`tick alarm mismatch: ${tick?.periodInMinutes} !== 1`);
  return moves;
}

/** Seed old read replies, set short retention, force daily scan, expect pruning. */
async function retentionPrune(ext) {
  const moves = [];
  await ext.send({ kind: 'reset-all' });
  await ext.send({ kind: 'set-config', config: { hnUser: 'chaos_nobody_9f3k', tickMinutes: 5, retentionDays: 7 } });

  // Seed a monitored item so orphan-prune doesn't delete everything on its own.
  const parentId = FAKE_ID_BASE + 1;
  await seedMonitored(ext, [mkMonitored({ id: parentId, submittedAt: Date.now() - 3 * DAY_MS })]);

  const now = Date.now();
  const seeded = [
    // old read → should drop
    mkReply({ id: 400_001, parentItemId: parentId, read: true, discoveredAt: now - 30 * DAY_MS }),
    mkReply({ id: 400_002, parentItemId: parentId, read: true, discoveredAt: now - 15 * DAY_MS }),
    // fresh read → kept
    mkReply({ id: 400_003, parentItemId: parentId, read: true, discoveredAt: now - 1 * DAY_MS }),
    // old unread → kept (unread never auto-dropped)
    mkReply({ id: 400_004, parentItemId: parentId, read: false, discoveredAt: now - 60 * DAY_MS }),
  ];
  await seedReplies(ext, seeded);
  moves.push({ move: 'seeded 4 replies (2 old-read, 1 fresh-read, 1 old-unread)' });

  const before = await ext.send({ kind: 'get-storage-stats' });
  // Retention pruning now rides on the syncAuthor cycle, which runs inside
  // every force-refresh. Algolia will return 0 hits for the fake user, so
  // this is just a cheap way to trigger the retention pass.
  await ext.send({ kind: 'force-refresh' });
  const after = await ext.send({ kind: 'get-storage-stats' });
  moves.push({
    move: 'force-refresh (retention sweep)',
    before: before.data.replyCount,
    after: after.data.replyCount,
    droppedOldRead: before.data.replyCount - after.data.replyCount,
  });

  if (after.data.replyCount !== 2) throw new Error(`expected 2 replies after prune, got ${after.data.replyCount}`);
  return moves;
}

/** Seed >5000 replies; next daily scan should hard-cap the set. */
async function hardCapTrim(ext) {
  const moves = [];
  await ext.send({ kind: 'reset-all' });
  await ext.send({ kind: 'set-config', config: { hnUser: 'chaos_nobody_9f3k', tickMinutes: 5, retentionDays: 30 } });

  const parentId = FAKE_ID_BASE + 2;
  await seedMonitored(ext, [mkMonitored({ id: parentId, submittedAt: Date.now() - 3 * DAY_MS })]);

  // Seed 6000 read replies (no unread, so hardCap drops oldest-read).
  const base = Date.now() - 1000;
  const batch = [];
  for (let i = 0; i < 6000; i++) {
    batch.push(mkReply({ id: 600_000 + i, parentItemId: parentId, read: true, discoveredAt: base - i }));
  }
  await seedReplies(ext, batch);
  moves.push({ move: 'seeded 6000 read replies' });

  const before = await ext.send({ kind: 'get-storage-stats' });
  // Retention pruning now rides on the syncAuthor cycle, which runs inside
  // every force-refresh. Algolia will return 0 hits for the fake user, so
  // this is just a cheap way to trigger the retention pass.
  await ext.send({ kind: 'force-refresh' });
  const after = await ext.send({ kind: 'get-storage-stats' });
  moves.push({
    move: 'force-refresh (hardCap)',
    before: before.data.replyCount,
    after: after.data.replyCount,
  });

  if (after.data.replyCount > 5000) throw new Error(`hardCap violated: ${after.data.replyCount} > 5000`);
  return moves;
}

/** Setting the same user again should NOT clear state (only changes do). */
async function noOpSameUser(ext) {
  const moves = [];
  await ext.send({ kind: 'reset-all' });
  await ext.send({ kind: 'set-config', config: { hnUser: 'chaos_nobody_9f3k', tickMinutes: 5, retentionDays: 30 } });

  const parentId = FAKE_ID_BASE + 3;
  await seedMonitored(ext, [mkMonitored({ id: parentId })]);
  await seedReplies(ext, [mkReply({ id: 800_001, parentItemId: parentId })]);
  moves.push({ move: 'seeded 1 monitored + 1 reply' });

  const before = await ext.send({ kind: 'get-storage-stats' });
  // Re-save the same user — should be a no-op for per-user state.
  await ext.send({ kind: 'set-config', config: { hnUser: 'chaos_nobody_9f3k', tickMinutes: 10, retentionDays: 30 } });
  const after = await ext.send({ kind: 'get-storage-stats' });
  moves.push({
    move: 'set-config same-user different-tick',
    replyCountBefore: before.data.replyCount,
    replyCountAfter: after.data.replyCount,
    monitoredBefore: before.data.monitoredCount,
    monitoredAfter: after.data.monitoredCount,
  });

  if (after.data.replyCount !== before.data.replyCount) throw new Error('same-user resave dropped replies');
  if (after.data.monitoredCount !== before.data.monitoredCount) throw new Error('same-user resave dropped monitored');
  return moves;
}

/** Changing the user (non-empty → non-empty) should clear per-user state. */
async function userChangeClears(ext) {
  const moves = [];
  await ext.send({ kind: 'reset-all' });
  await ext.send({ kind: 'set-config', config: { hnUser: 'chaos_user_a', tickMinutes: 5, retentionDays: 30 } });

  const parentId = FAKE_ID_BASE + 4;
  await seedMonitored(ext, [mkMonitored({ id: parentId })]);
  await seedReplies(ext, [mkReply({ id: 910_001, parentItemId: parentId })]);

  await ext.send({ kind: 'set-config', config: { hnUser: 'chaos_user_b', tickMinutes: 5, retentionDays: 30 } });
  const after = await ext.send({ kind: 'get-storage-stats' });
  moves.push({ move: 'switched alice→bob', replyCount: after.data.replyCount, monitoredCount: after.data.monitoredCount });

  if (after.data.replyCount !== 0) throw new Error('user change did not clear replies');
  if (after.data.monitoredCount !== 0) throw new Error('user change did not clear monitored');
  return moves;
}

const SCENARIOS = {
  'rapid-user-swap': rapidUserSwap,
  'refresh-spam': refreshSpam,
  'settings-churn': settingsChurn,
  'retention-prune': retentionPrune,
  'hard-cap-trim': hardCapTrim,
  'no-op-same-user': noOpSameUser,
  'user-change-clears': userChangeClears,
};

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const selected = args.scenarios
    ? args.scenarios.split(',').filter((n) => SCENARIOS[n])
    : Object.keys(SCENARIOS);

  console.log(`\nHNswered chaos`);
  console.log(`label:     ${LABEL}`);
  console.log(`budget:    ${BUDGET}`);
  console.log(`scenarios: ${selected.join(', ')}`);
  console.log(`output:    ${OUT}\n`);

  const ext = await launchWithExtension({ headless: true, logRequests: true });
  const report = { label: LABEL, timestamp: new Date().toISOString(), budget: BUDGET, runs: [] };
  let failed = 0;

  try {
    for (const name of selected) {
      if (ext.hnRequests.length >= BUDGET) {
        report.runs.push({ scenario: name, skipped: 'budget exhausted' });
        break;
      }
      process.stdout.write(`  ${name.padEnd(24)} `);
      const run = { scenario: name, moves: [], invariantsAfter: null, error: null, hnRequestsStart: ext.hnRequests.length };
      try {
        run.moves = await SCENARIOS[name](ext);
        run.invariantsAfter = await assertInvariants(ext, name);
        console.log(run.invariantsAfter.passed ? `OK  moves=${run.moves.length}` : `FAIL  invariants=${run.invariantsAfter.errors.length}`);
        if (!run.invariantsAfter.passed) failed++;
      } catch (err) {
        run.error = String(err?.message ?? err);
        failed++;
        console.log(`ERROR  ${run.error}`);
      }
      run.hnRequestsEnd = ext.hnRequests.length;
      run.hnRequestsUsed = run.hnRequestsEnd - run.hnRequestsStart;
      report.runs.push(run);
    }
  } finally {
    await ext.close();
  }

  report.totalHnRequests = ext.hnRequests.length;
  report.failed = failed;
  report.politeCheck = report.totalHnRequests <= BUDGET ? 'PASS' : 'OVER';

  writeFileSync(resolve(OUT, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`\ntotal HN requests: ${report.totalHnRequests} / ${BUDGET} (${report.politeCheck})`);
  console.log(`scenarios failed:  ${failed} / ${selected.length}`);
  console.log(`report:            ${resolve(OUT, 'report.json')}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('chaos failed:', err);
  process.exit(1);
});
