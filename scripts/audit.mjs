#!/usr/bin/env node
/**
 * Live audit harness — parallel multi-user observation of the extension.
 *
 * Launches one Chrome per HN handle (separate userDataDir) in parallel, lets
 * each extension instance run on its natural alarm cadence (default 5-min
 * tickMinutes — production-realistic), and snapshots every N minutes into a
 * checkpoints.jsonl time series. After the run, hand off to audit-analyze.mjs
 * for deterministic divergence checks against live HN.
 *
 * Usage:
 *   node scripts/audit.mjs --label=nightly-audit \
 *                          --users=mfiguiere,dang,pg,patio11 \
 *                          --duration=60 \
 *                          --interval=15 \
 *                          --budget=4000
 *
 * Defaults: 4 users (must pass --users — no auto-discovery; we want the
 * developer to consciously choose handles), 60-min duration, 15-min snapshot
 * interval, 4000-request budget across all users.
 *
 * Politeness: at default tickMinutes=5 the extension does ~30-50 req/tick on
 * a warm monitored set. 4 users × 12 ticks/hr × ~40 req = ~2000 req/hr. The
 * 4000 budget gives ~2 hours of headroom; runs longer than that should bump
 * the budget explicitly. Budget hit ⇒ all instances stopped, partial data
 * still written and analyzed.
 *
 * Output: .audit/<label>/
 *   checkpoints.jsonl       one snapshot line per (user, t)
 *   summary.json            per-user totals, request counts, politeness check
 *   logs/<user>.log         JSONL events per user (errors, snapshot stats)
 */
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchWithExtension } from './lib/extension.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');

// ── Args ───────────────────────────────────────────────────────────────────

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  }),
);

if (!args.users) {
  console.error('Usage: node scripts/audit.mjs --label=<name> --users=a,b,c[,d] [--duration=60] [--interval=15] [--budget=4000]');
  console.error('  --users is required. No auto-discovery — pick the handles you want to observe.');
  process.exit(2);
}

const LABEL = args.label ?? `audit-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const USERS = args.users.split(',').map((s) => s.trim()).filter(Boolean);
const DURATION_MIN = Number(args.duration ?? 60);
const INTERVAL_MIN = Number(args.interval ?? 15);
const BUDGET = Number(args.budget ?? 4000);
const HEADLESS = args.headless !== 'false';

if (USERS.length === 0) {
  console.error('No users provided.');
  process.exit(2);
}
if (INTERVAL_MIN <= 0 || DURATION_MIN <= 0) {
  console.error('--duration and --interval must be positive minutes.');
  process.exit(2);
}
if (INTERVAL_MIN > DURATION_MIN) {
  console.error(`--interval (${INTERVAL_MIN}min) cannot exceed --duration (${DURATION_MIN}min) — no snapshots would be taken.`);
  process.exit(2);
}

const OUT = resolve(REPO, '.audit', LABEL);
const LOG_DIR = resolve(OUT, 'logs');
mkdirSync(LOG_DIR, { recursive: true });
const CHECKPOINTS_PATH = resolve(OUT, 'checkpoints.jsonl');
const SUMMARY_PATH = resolve(OUT, 'summary.json');

// ── Per-user logger ────────────────────────────────────────────────────────

function logger(user) {
  const path = resolve(LOG_DIR, `${user}.log`);
  return (event, data = {}) => {
    const line = JSON.stringify({ t: new Date().toISOString(), user, event, ...data }) + '\n';
    try { appendFileSync(path, line); } catch {}
  };
}

// ── Per-user run ───────────────────────────────────────────────────────────

async function startUser(user) {
  const log = logger(user);
  log('launching');
  const ext = await launchWithExtension({ headless: HEADLESS, logRequests: true });
  log('launched', { extensionId: ext.extensionId });
  // Configure the handle. NOTE: the lib/extension.mjs wrapper handles set-config
  // but does NOT kick off `void runRefresh()` that the production message
  // handler does (wrapper predates the first-configure fix in commit 5db538c).
  // We explicitly force-refresh below to populate the monitored set before the
  // first snapshot. Same pattern impersonate.mjs uses.
  const cfg = await ext.send({ kind: 'set-config', config: { hnUser: user, tickMinutes: 5, retentionDays: 30 } });
  log('configured', { ok: cfg?.ok, config: cfg?.data });
  log('initial-force-refresh');
  const reqsBefore = ext.hnRequests.length;
  const refresh = await ext.send({ kind: 'force-refresh' });
  const reqsAfter = ext.hnRequests.length;
  log('initial-force-refresh-done', { ok: refresh?.ok, requests: reqsAfter - reqsBefore });
  return { user, ext, log };
}

async function snapshotUser({ user, ext, log }, runId) {
  const inspect = await ext.send({ kind: 'inspect' });
  if (!inspect?.ok) {
    log('snapshot-failed', { error: inspect?.error });
    return null;
  }
  const data = inspect.data;
  const monitored = data.monitored ?? [];
  const checkpoint = {
    t: new Date().toISOString(),
    runId,
    user,
    config: data.config,
    timestamps: data.timestamps,
    monitoredCount: monitored.length,
    replyCount: data.replyCount,
    unreadCount: data.unreadCount,
    monitored: monitored.map((m) => ({
      id: m.id,
      type: m.type,
      submittedAt: m.submittedAt,
      lastDescendants: m.lastDescendants ?? 0,
      lastKidsCount: (m.lastKids ?? []).length,
      lastKids: m.lastKids ?? [],
    })),
    hnRequestsSoFar: ext.hnRequests.length,
  };
  log('snapshot', { monitored: monitored.length, replies: data.replyCount, requests: ext.hnRequests.length });
  appendFileSync(CHECKPOINTS_PATH, JSON.stringify(checkpoint) + '\n');
  return checkpoint;
}

async function getReplies({ user, ext, log }) {
  const r = await ext.send({ kind: 'list-replies' });
  if (!r?.ok) {
    log('list-replies-failed', { error: r?.error });
    return [];
  }
  return r.data ?? [];
}

// ── Main ───────────────────────────────────────────────────────────────────

function totalRequests(instances) {
  return instances.reduce((acc, i) => acc + (i?.ext?.hnRequests?.length ?? 0), 0);
}

async function main() {
  console.log(`\nHNswered live audit`);
  console.log(`  label:     ${LABEL}`);
  console.log(`  users:     ${USERS.join(', ')}`);
  console.log(`  duration:  ${DURATION_MIN} min`);
  console.log(`  interval:  ${INTERVAL_MIN} min (${Math.floor(DURATION_MIN / INTERVAL_MIN)} snapshots planned)`);
  console.log(`  budget:    ${BUDGET} HN requests across all users`);
  console.log(`  out:       ${OUT}\n`);

  // Launch in parallel — each call gets its own tmpdir userDataDir.
  console.log('launching all instances in parallel...');
  const startTs = Date.now();
  let instances;
  try {
    instances = await Promise.all(USERS.map(startUser));
  } catch (err) {
    console.error('launch failed:', err);
    process.exit(1);
  }
  console.log(`  ${instances.length} instances up in ${Date.now() - startTs}ms\n`);

  // Initial snapshot at t=0 captures the post-set-config state. Useful as a
  // baseline for later "what did this user discover during the audit window".
  console.log('snapshot 0 (baseline after set-config)...');
  await Promise.all(instances.map((i) => snapshotUser(i, 0)));

  const endAt = Date.now() + DURATION_MIN * 60_000;
  const intervalMs = INTERVAL_MIN * 60_000;
  let nextSnapshotAt = Date.now() + intervalMs;
  let snapshotIdx = 1;
  let stopReason = 'duration-elapsed';

  // Tight idle loop: every 1s check budget + whether it's snapshot time.
  // Sleeping for a full interval would block budget enforcement.
  while (Date.now() < endAt) {
    const reqs = totalRequests(instances);
    if (reqs >= BUDGET) {
      stopReason = 'budget-hit';
      console.log(`\n!! budget hit (${reqs}/${BUDGET}) — stopping early`);
      break;
    }
    if (Date.now() >= nextSnapshotAt) {
      const remaining = Math.max(0, endAt - Date.now());
      console.log(`snapshot ${snapshotIdx} (t+${Math.round((Date.now() - startTs) / 60_000)}min, requests so far: ${reqs}, ${Math.round(remaining / 60_000)}min remaining)...`);
      await Promise.all(instances.map((i) => snapshotUser(i, snapshotIdx)));
      snapshotIdx++;
      nextSnapshotAt += intervalMs;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  // Final snapshot + capture replies for analyzer to diff against ground truth.
  console.log(`\nfinal snapshot...`);
  const finals = await Promise.all(instances.map(async (i) => {
    const checkpoint = await snapshotUser(i, snapshotIdx);
    const replies = await getReplies(i);
    return { user: i.user, checkpoint, replies };
  }));

  // Write per-user replies for the analyzer (one file per user keeps things
  // readable and lets the analyzer process them independently).
  for (const { user, replies } of finals) {
    writeFileSync(resolve(OUT, `replies-${user}.json`), JSON.stringify(replies, null, 2));
  }

  // Stop all instances.
  console.log('closing instances...');
  await Promise.all(instances.map((i) => i.ext.close().catch(() => {})));

  const totalReqs = totalRequests(instances);
  const summary = {
    label: LABEL,
    timestamp: new Date().toISOString(),
    durationMin: DURATION_MIN,
    intervalMin: INTERVAL_MIN,
    budget: BUDGET,
    stopReason,
    elapsedMs: Date.now() - startTs,
    totalRequests: totalReqs,
    politeCheck: totalReqs <= BUDGET ? 'PASS' : 'OVER',
    perUser: finals.map(({ user, checkpoint, replies }) => ({
      user,
      monitoredCount: checkpoint?.monitoredCount ?? 0,
      replyCount: checkpoint?.replyCount ?? 0,
      unreadCount: checkpoint?.unreadCount ?? 0,
      replyIds: replies.map((r) => r.id),
    })),
  };
  writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2));

  console.log(`\ndone in ${Math.round((Date.now() - startTs) / 60_000)}min  reason=${stopReason}  totalRequests=${totalReqs}/${BUDGET}`);
  console.log(`  ${OUT}/`);
  console.log(`  ├── checkpoints.jsonl    (${snapshotIdx + 1} snapshots × ${USERS.length} users)`);
  console.log(`  ├── summary.json`);
  console.log(`  ├── replies-<user>.json  (per-user, ${USERS.length} files)`);
  console.log(`  └── logs/<user>.log      (per-user JSONL events)`);
  console.log(`\nnext: node scripts/audit-analyze.mjs --label=${LABEL}`);
}

main().catch((err) => {
  console.error('audit failed:', err);
  process.exit(1);
});
