#!/usr/bin/env node
/**
 * "Pretend to be a popular HN user" test harness.
 *
 * Strategy:
 *   1. Pick a candidate mode: "poster" or "commenter".
 *      - poster: discover a currently-popular story author by fetching /v0/topstories
 *        and /v0/beststories directly (ONE request each, total).
 *      - commenter: discover an active commenter by sampling top comments on one top story.
 *   2. Configure the extension with that username and force a tick.
 *   3. Force daily-scan and weekly-scan to exercise all bucket paths.
 *   4. Measure: replies discovered, monitored set size + age distribution,
 *      total outbound HN requests made by the extension (via CDP network events).
 *   5. Repeat for each user in --users (comma-separated) if provided.
 *
 * SERVER POLITENESS:
 *   - Per-run request budget enforced (default 200). Aborts if exceeded.
 *   - Single user per run unless --users is passed.
 *   - Exits when budget hit; summary still written.
 *
 * Usage:
 *   node scripts/impersonate.mjs --label=smoke [--users=dang,pg] [--mode=poster|commenter|auto]
 *                                 [--headless=true] [--budget=200] [--windowMs=60000]
 *                                 [--demo=3]
 *
 * --demo=N: seeds N top stories into the monitored set so the next force-refresh
 *          treats all recent comments on those stories (within the Algolia
 *          overlap window) as "new replies". Proves end-to-end detection
 *          without waiting for real-time activity.
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
const LABEL = args.label ?? `impersonate-${Date.now()}`;
const HEADLESS = args.headless !== 'false';
const BUDGET = Number(args.budget ?? 200);
const WINDOW_MS = Number(args.windowMs ?? 60_000);
const MODE = args.mode ?? 'auto'; // poster | commenter | auto
const EXPLICIT_USERS = args.users ? args.users.split(',').filter(Boolean) : null;
const DEMO = args.demo ? Number(args.demo) : 0;

const OUT = resolve(REPO, '.impersonate', LABEL);
mkdirSync(OUT, { recursive: true });

async function hnFetch(path) {
  const res = await fetch(`https://hacker-news.firebaseio.com/v0${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
  return res.json();
}

/** Discover candidate users, costing at most ~6 upstream requests total. */
async function discover() {
  const [top, best] = await Promise.all([
    hnFetch('/topstories.json'),
    hnFetch('/beststories.json'),
  ]);
  const candidateStoryId = top[0] ?? best[0];
  const story = await hnFetch(`/item/${candidateStoryId}.json`);
  const poster = story?.by;
  let commenter = null;
  let commenterStoryAuthor = null;
  for (const kidId of (story?.kids ?? []).slice(0, 3)) {
    const c = await hnFetch(`/item/${kidId}.json`);
    if (c?.by && !c.deleted && !c.dead) {
      commenter = c.by;
      commenterStoryAuthor = story?.by;
      break;
    }
  }
  return {
    poster,
    commenter,
    posterStoryTitle: story?.title,
    posterStoryId: story?.id,
    commenterStoryAuthor,
  };
}

async function seedDemoStories(ext, n) {
  const top = await hnFetch('/topstories.json');
  const picks = top.slice(0, n);
  const seeded = [];
  for (const id of picks) {
    const item = await hnFetch(`/item/${id}.json`);
    if (!item || item.deleted || item.dead) continue;
    seeded.push({
      id: item.id,
      type: item.type === 'story' ? 'story' : 'comment',
      submittedAt: (item.time ?? Math.floor(Date.now() / 1000)) * 1000,
      title: item.title,
    });
  }
  await ext.sw.evaluate(async (items) => {
    const map = {};
    for (const it of items) map[String(it.id)] = it;
    await chrome.storage.local.set({ monitored: map });
  }, seeded);
  return seeded;
}

async function runUser(ext, username, mode) {
  console.log(`\n--- impersonating ${username} (${mode}) ---`);
  await ext.send({ kind: 'reset-all' });
  await ext.send({ kind: 'set-config', config: { hnUser: username, tickMinutes: 5 } });

  let seeded = [];
  if (DEMO > 0) {
    console.log(`  [demo] seeding ${DEMO} top stories ...`);
    seeded = await seedDemoStories(ext, DEMO);
    console.log(`    seeded: ${seeded.map((s) => s.id).join(', ')}`);
  }

  const t0 = Date.now();

  // One force-refresh runs syncAuthor + pollComments. The old three-step
  // force-tick / force-daily-scan / force-weekly-scan dance is gone — the
  // Algolia-first design has no age-bucket scans.
  console.log(`  force-refresh...`);
  const refreshStart = ext.hnRequests.length;
  const refreshRes = await ext.send({ kind: 'force-refresh' });
  const refreshReqs = ext.hnRequests.length - refreshStart;
  console.log(`    ${refreshReqs} requests, ok=${refreshRes?.ok}`);

  // Optional quiet observation window — badge should reflect state.
  const observeUntil = Date.now() + WINDOW_MS;
  while (Date.now() < observeUntil && ext.hnRequests.length < BUDGET) {
    await new Promise((r) => setTimeout(r, 1000));
  }

  const monitored = await ext.send({ kind: 'get-monitored' });
  const replies = await ext.send({ kind: 'list-replies' });

  const now = Date.now();
  // Informational age histogram — Algolia-first design does not bucket-scan,
  // but the age distribution of monitored items is still useful to eyeball
  // during an impersonate run.
  const ageHist = { under1d: 0, under1w: 0, under30d: 0, under365d: 0 };
  const DAY = 86400_000;
  for (const m of monitored?.data ?? []) {
    const age = now - m.submittedAt;
    if (age < DAY) ageHist.under1d++;
    else if (age < 7 * DAY) ageHist.under1w++;
    else if (age < 30 * DAY) ageHist.under30d++;
    else ageHist.under365d++;
  }

  console.log(`  summary: monitored=${monitored?.data?.length ?? 0} replies=${replies?.data?.length ?? 0} totalReqs=${ext.hnRequests.length}`);
  if (DEMO > 0 && (replies?.data?.length ?? 0) > 0) {
    console.log(`  [demo] ✓ detection pipeline proven — ${replies.data.length} replies surfaced`);
  } else if (DEMO > 0) {
    console.log(`  [demo] ✗ no replies detected; either stories had no comments or pipeline is broken`);
  }
  return {
    username,
    mode,
    elapsed_ms: Date.now() - t0,
    monitoredCount: monitored?.data?.length ?? 0,
    repliesCount: replies?.data?.length ?? 0,
    ageHist,
    oldestMonitoredAgeDays: (monitored?.data ?? []).reduce(
      (acc, m) => Math.max(acc, (now - m.submittedAt) / DAY),
      0,
    ),
    sampleReplies: (replies?.data ?? []).slice(0, 5).map((r) => ({
      id: r.id,
      author: r.author,
      parentItemTitle: r.parentItemTitle,
      time: r.time,
    })),
    requests: {
      refresh: refreshReqs,
      totalAtEnd: ext.hnRequests.length,
    },
  };
}

async function main() {
  console.log(`\nHNswered impersonate`);
  console.log(`label:   ${LABEL}`);
  console.log(`budget:  ${BUDGET} requests`);
  console.log(`mode:    ${MODE}`);
  console.log(`output:  ${OUT}\n`);

  let discovery = { poster: null, commenter: null };
  let users = EXPLICIT_USERS;
  if (!users) {
    console.log('discovering candidates via topstories/beststories...');
    discovery = await discover();
    console.log(`  poster candidate:    ${discovery.poster}`);
    console.log(`  commenter candidate: ${discovery.commenter}`);
    if (MODE === 'poster') users = [discovery.poster];
    else if (MODE === 'commenter') users = [discovery.commenter];
    else users = [discovery.poster, discovery.commenter].filter(Boolean);
  }

  const ext = await launchWithExtension({ headless: HEADLESS, logRequests: true });
  const results = [];
  try {
    for (const u of users) {
      if (ext.hnRequests.length >= BUDGET) {
        console.log(`budget (${BUDGET}) exhausted; stopping.`);
        break;
      }
      const mode = discovery.poster === u ? 'poster' : discovery.commenter === u ? 'commenter' : 'explicit';
      const r = await runUser(ext, u, mode);
      results.push(r);
    }
  } finally {
    await ext.close();
  }

  const totalReqs = results.reduce((a, r) => Math.max(a, r.requests.totalAtEnd), 0);
  const summary = {
    label: LABEL,
    timestamp: new Date().toISOString(),
    budget: BUDGET,
    observedWindowMs: WINDOW_MS,
    discovery,
    totalRequests: totalReqs,
    politeCheck: totalReqs <= BUDGET ? 'PASS' : 'OVER',
    results,
  };
  writeFileSync(resolve(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(`\nsummary: ${resolve(OUT, 'summary.json')}`);
  console.log(`total HN requests across run: ${totalReqs} (budget: ${BUDGET})\n`);
}

main().catch((err) => {
  console.error('impersonate failed:', err);
  process.exit(1);
});
