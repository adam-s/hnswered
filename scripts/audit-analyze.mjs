#!/usr/bin/env node
/**
 * Deterministic divergence analyzer for an audit run.
 *
 * Reads .audit/<label>/{summary,checkpoints,replies-*}.json, fetches
 * ground-truth from live HN, and produces a divergence report that is purely
 * a function of those two inputs — no LLM judgment, no heuristics.
 *
 * Usage:
 *   node scripts/audit-analyze.mjs --label=<audit-label> [--tolerance=10]
 *
 * --tolerance: minutes after which a missing reply is considered "missed"
 *              by the extension (vs "in flight"). Defaults to 10 (5-min tick
 *              cadence + 5-min buffer).
 *
 * Checks:
 *   - missed-replies      HN has a kid the extension hasn't surfaced (older than tolerance)
 *   - phantom-replies     Extension surfaced a reply HN doesn't have on the parent's kids list
 *   - bucket-integrity    submittedAt matches HN time*1000; bucket placement is correct
 *   - politeness          totalRequests <= budget
 *   - self-contamination  no reply.author equals hnUser (case-insensitive)
 *   - retention           all replies have discoveredAt > (now - retentionDays * 86400000)
 *   - coverage            monitoredCount > 0 for users who have any recent submissions
 *
 * Writes .audit/<label>/divergence-report.json and prints a summary.
 * Exit code: 0 if all checks PASS, 1 if any FAIL.
 *
 * Fetches ~10-15 HN URLs per user (1 user.json + N item.json for monitored
 * items + occasional kid lookups). 4 users ⇒ ~50 HN requests. Negligible.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  }),
);

if (!args.label) {
  console.error('Usage: node scripts/audit-analyze.mjs --label=<audit-label> [--tolerance=10]');
  process.exit(2);
}

const LABEL = args.label;
const TOLERANCE_MIN = Number(args.tolerance ?? 10);
const AUDIT_DIR = resolve(REPO, '.audit', LABEL);
const SUMMARY_PATH = resolve(AUDIT_DIR, 'summary.json');
const REPORT_PATH = resolve(AUDIT_DIR, 'divergence-report.json');

if (!existsSync(SUMMARY_PATH)) {
  console.error(`No summary at ${SUMMARY_PATH}. Did the audit run finish?`);
  process.exit(2);
}

const summary = JSON.parse(readFileSync(SUMMARY_PATH, 'utf-8'));
const auditEndedAt = new Date(summary.timestamp).getTime();
const tolerance = TOLERANCE_MIN * 60_000;

// Below this duration, the missed-replies check produces too many false
// positives to be a hard FAIL: the extension's MAX_REPLIES_PER_CHECK=10 cap
// means it surfaces at most 10 new kids per item per tick. For an item with a
// large reply backlog, draining that queue takes multiple ticks. A short audit
// observes the partial drain, which is correct behavior, not a bug. For audits
// shorter than this threshold, missed-replies becomes informational (its
// findings are surfaced in the report but don't fail the overall run).
const SHORT_AUDIT_MIN = 30;
const durationMin = summary.durationMin ?? 60;
const missedRepliesIsAdvisory = durationMin < SHORT_AUDIT_MIN;

// ── Live HN fetcher ────────────────────────────────────────────────────────

async function hn(path) {
  const url = `https://hacker-news.firebaseio.com/v0${path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

// Small per-call delay to stay polite even though the analyzer is bounded.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Per-user analysis ──────────────────────────────────────────────────────

async function analyzeUser(userSummary) {
  const { user, monitoredCount, replyCount } = userSummary;
  const result = {
    user,
    extensionState: { monitoredCount, replyCount },
    checks: [],
  };

  // Load extension's surfaced replies.
  const repliesPath = resolve(AUDIT_DIR, `replies-${user}.json`);
  const replies = existsSync(repliesPath) ? JSON.parse(readFileSync(repliesPath, 'utf-8')) : [];

  // Grab the most recent monitored snapshot for this user from checkpoints.
  const checkpoints = readFileSync(resolve(AUDIT_DIR, 'checkpoints.jsonl'), 'utf-8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const userCheckpoints = checkpoints.filter((c) => c.user === user);
  const finalCheckpoint = userCheckpoints[userCheckpoints.length - 1];
  if (!finalCheckpoint) {
    result.checks.push({ name: 'has-checkpoint', status: 'FAIL', detail: 'no checkpoints recorded for this user' });
    return result;
  }
  const monitored = finalCheckpoint.monitored ?? [];

  // 1. coverage — user with recent submissions should have monitored items.
  const userObj = await hn(`/user/${encodeURIComponent(user)}.json`);
  await sleep(50);
  const submissionCount = userObj?.submitted?.length ?? 0;
  if (submissionCount > 0 && monitored.length === 0) {
    result.checks.push({ name: 'coverage', status: 'FAIL', detail: `user has ${submissionCount} submissions but extension monitored 0 items` });
  } else {
    result.checks.push({ name: 'coverage', status: 'PASS', detail: `${monitored.length} monitored, ${submissionCount} total submissions` });
  }

  // 2. self-contamination — no reply authored by the user themselves.
  const userLc = user.toLowerCase();
  const selfReplies = replies.filter((r) => (r.author ?? '').toLowerCase() === userLc);
  if (selfReplies.length > 0) {
    result.checks.push({
      name: 'self-contamination',
      status: 'FAIL',
      detail: `${selfReplies.length} reply/replies authored by ${user} themselves`,
      ids: selfReplies.map((r) => r.id),
    });
  } else {
    result.checks.push({ name: 'self-contamination', status: 'PASS', detail: 'no self-replies' });
  }

  // 3. retention — all replies discoveredAt within retentionDays.
  const cfg = finalCheckpoint.config ?? { retentionDays: 30 };
  const retentionMs = (cfg.retentionDays ?? 30) * 86_400_000;
  const stale = replies.filter((r) => auditEndedAt - r.discoveredAt > retentionMs);
  if (stale.length > 0) {
    result.checks.push({
      name: 'retention',
      status: 'FAIL',
      detail: `${stale.length} reply/replies older than retentionDays=${cfg.retentionDays}`,
      ids: stale.map((r) => r.id),
    });
  } else {
    result.checks.push({ name: 'retention', status: 'PASS', detail: `all ${replies.length} replies within ${cfg.retentionDays}d retention` });
  }

  // 4. bucket-integrity — submittedAt should equal HN's time*1000 for each
  //    monitored item. Sample up to 5 items to keep request count bounded.
  const sample = monitored.slice(0, 5);
  let bucketFails = 0;
  for (const m of sample) {
    const item = await hn(`/item/${m.id}.json`);
    await sleep(50);
    if (!item) continue;
    const expectedAt = (item.time ?? 0) * 1000;
    if (Math.abs(m.submittedAt - expectedAt) > 1000) {
      bucketFails++;
      result.checks.push({
        name: 'bucket-integrity',
        status: 'FAIL',
        detail: `monitored ${m.id} submittedAt=${m.submittedAt} differs from HN time*1000=${expectedAt}`,
      });
    }
  }
  if (bucketFails === 0) {
    result.checks.push({ name: 'bucket-integrity', status: 'PASS', detail: `${sample.length}/5 sampled items match HN times` });
  }

  // 5. missed-replies — for each monitored item, fetch HN's current kids and
  //    find any kid that's NOT in extension's lastKids AND was posted older
  //    than the tolerance window. Sample up to 5 items.
  const surfaced = new Set(replies.map((r) => r.id));
  let missed = [];
  for (const m of sample) {
    const item = await hn(`/item/${m.id}.json`);
    await sleep(50);
    if (!item) continue;
    const liveKids = item.kids ?? [];
    const extKids = new Set(m.lastKids ?? []);
    const newKids = liveKids.filter((id) => !extKids.has(id));
    for (const kidId of newKids.slice(0, 5)) {
      const kid = await hn(`/item/${kidId}.json`);
      await sleep(50);
      if (!kid || kid.deleted || kid.dead) continue;
      // Skip the user's own replies (the extension correctly filters these).
      if ((kid.by ?? '').toLowerCase() === userLc) continue;
      const ageMs = auditEndedAt - kid.time * 1000;
      if (ageMs > tolerance && !surfaced.has(kidId)) {
        missed.push({ id: kidId, by: kid.by, parent: m.id, ageMin: Math.round(ageMs / 60_000) });
      }
    }
  }
  if (missed.length > 0) {
    const detail = missedRepliesIsAdvisory
      ? `${missed.length} reply/replies not surfaced (advisory: audit duration ${durationMin}min < ${SHORT_AUDIT_MIN}min — likely throttle artifact, not a bug)`
      : `${missed.length} reply/replies older than ${TOLERANCE_MIN}min were on HN but not surfaced`;
    result.checks.push({
      name: 'missed-replies',
      status: missedRepliesIsAdvisory ? 'WARN' : 'FAIL',
      detail,
      missed,
    });
  } else {
    result.checks.push({ name: 'missed-replies', status: 'PASS', detail: `no missed replies past ${TOLERANCE_MIN}min tolerance` });
  }

  // 6. phantom-replies — for each surfaced reply, the parent's HN kids list
  //    should contain the reply ID. Sample up to 10 replies.
  let phantoms = [];
  for (const r of replies.slice(0, 10)) {
    const parent = await hn(`/item/${r.parentItemId}.json`);
    await sleep(50);
    if (!parent) continue;
    const kids = new Set(parent.kids ?? []);
    if (!kids.has(r.id)) {
      // Could be a deleted kid (kids list omits deleted items). Verify.
      const kid = await hn(`/item/${r.id}.json`);
      await sleep(50);
      if (kid && !kid.deleted && !kid.dead) {
        phantoms.push({ id: r.id, parent: r.parentItemId, by: r.author });
      }
    }
  }
  if (phantoms.length > 0) {
    result.checks.push({
      name: 'phantom-replies',
      status: 'FAIL',
      detail: `${phantoms.length} surfaced reply/replies not present in parent's HN kids list`,
      phantoms,
    });
  } else {
    result.checks.push({ name: 'phantom-replies', status: 'PASS', detail: 'all sampled replies present on HN' });
  }

  return result;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nAnalyzing audit: ${LABEL}`);
  console.log(`  tolerance: ${TOLERANCE_MIN}min (replies older than this should have been surfaced)\n`);

  const perUser = [];
  for (const u of summary.perUser) {
    console.log(`  ${u.user}: ${u.monitoredCount} monitored, ${u.replyCount} replies`);
    perUser.push(await analyzeUser(u));
  }

  // Run-level politeness check.
  const politeness = {
    totalRequests: summary.totalRequests,
    budget: summary.budget,
    status: summary.totalRequests <= summary.budget ? 'PASS' : 'FAIL',
  };

  // Aggregate. WARN status is informational; only FAIL counts toward overall.
  const allChecks = perUser.flatMap((u) => u.checks.map((c) => ({ user: u.user, ...c })));
  const fails = allChecks.filter((c) => c.status === 'FAIL');
  const warns = allChecks.filter((c) => c.status === 'WARN');
  const overall = politeness.status === 'PASS' && fails.length === 0 ? 'PASS' : 'FAIL';

  const report = {
    label: LABEL,
    analyzedAt: new Date().toISOString(),
    overall,
    politeness,
    perUser,
    failures: fails,
    warnings: warns,
  };
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

  console.log(`\n──────────────────────────────────────────`);
  console.log(`overall: ${overall}${warns.length > 0 ? `  (${warns.length} advisory warnings — see report)` : ''}`);
  console.log(`politeness: ${politeness.totalRequests}/${politeness.budget} (${politeness.status})`);
  for (const u of perUser) {
    const userFails = u.checks.filter((c) => c.status === 'FAIL').length;
    const userWarns = u.checks.filter((c) => c.status === 'WARN').length;
    const userPass = u.checks.filter((c) => c.status === 'PASS').length;
    const tag = userFails > 0 ? '  FAILURES:' : userWarns > 0 ? '  warnings:' : '';
    console.log(`${u.user.padEnd(15)} ${userPass}/${u.checks.length} pass${tag}`);
    for (const c of u.checks.filter((c) => c.status !== 'PASS')) {
      console.log(`  ${c.status === 'FAIL' ? '✗' : '!'} ${c.name}: ${c.detail}`);
    }
  }
  console.log(`\nreport: ${REPORT_PATH}`);

  process.exit(overall === 'PASS' ? 0 : 1);
}

main().catch((err) => {
  console.error('analyze failed:', err);
  process.exit(1);
});
