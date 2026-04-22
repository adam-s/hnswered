#!/usr/bin/env node
/**
 * Visual snapshot tool for the HNswered side panel.
 *
 * Captures each seeded state at BOTH a narrow (360px) and wide (990px) viewport —
 * the realistic range of a Chrome side panel. Writes PNGs + summary JSON.
 *
 * States:
 *   - empty          (no config yet)
 *   - one-unread     (1 unread reply)
 *   - fifty-unread   (50 unread replies)
 *   - read-only      (0 unread + 1 read — tests divider discipline)
 *   - settings       (settings page)
 *
 * Usage:
 *   node scripts/snapshot.mjs [--label=round1] [--headless=false]
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
const LABEL = args.label ?? `snap-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const HEADLESS = args.headless !== 'false';
const OUT = resolve(REPO, '.snapshots', LABEL);
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { name: 'narrow', width: 360, height: 900 },
  { name: 'wide', width: 990, height: 900 },
];

function seedReplies(n, opts = {}) {
  const { allRead = false, titles = true, parentsAreComments = false } = opts;
  const now = Date.now();
  const out = {};
  const parentExcerpts = [
    'That framing misses the deeper point — the real constraint is not the algorithm itself but the observability story around it.',
    'Worth noting that the 2019 RFC already addressed a version of this, though admittedly with weaker guarantees about ordering.',
    'I disagree. The cost model assumed in the paper breaks once you account for network jitter in the hot path.',
    'Fair, but consider the counter-case: a user on a throttled mobile connection will see completely different latency characteristics here.',
    'This matches my experience running this at scale. The edge case you are describing is rare but catastrophic when it hits.',
    'The title is a bit clickbaity, but the benchmark section is actually quite rigorous once you get past the intro.',
  ];
  for (let i = 0; i < n; i++) {
    const id = 10_000_000 + i;
    const base = {
      id,
      parentItemId: 42_000_000 + (i % 5),
      author: ['alice', 'bob', 'carol', 'dan', 'eve', 'frank_q'][i % 6],
      text: `<p>Reply ${i}: I mostly agree, but one detail I'd push back on — <i>the middle paragraph</i> assumes readers already have context. <a href="https://example.com/x">here's a link</a>.</p><p>The second point is stronger though.</p>`,
      time: now - i * 7 * 60_000,
      read: allRead,
      discoveredAt: now - i * 30_000,
    };
    if (parentsAreComments || (titles && i % 2 === 1)) {
      base.parentAuthor = ['you', 'jsmith', 'mitch', 'rhoward', 'pgibbons', 'lburgan'][i % 6];
      base.parentExcerpt = parentExcerpts[i % parentExcerpts.length];
    } else if (titles) {
      base.parentItemTitle = `Show HN: A thing you will love (post ${i % 5})`;
    }
    out[String(id)] = base;
  }
  return out;
}

const STATES = [
  {
    name: 'empty',
    async setup(ext) { await ext.send({ kind: 'reset-all' }); },
  },
  {
    name: 'one-unread',
    async setup(ext) {
      await ext.send({ kind: 'reset-all' });
      await ext.send({ kind: 'set-config', config: { hnUser: 'pg', tickMinutes: 5 } });
      await ext.sw.evaluate(async (r) => chrome.storage.local.set({ replies: r }), seedReplies(1));
    },
  },
  {
    name: 'many-mixed',
    async setup(ext) {
      // 120 replies, first 20 unread, remaining read — exercises filter tabs + "More" pagination
      await ext.send({ kind: 'reset-all' });
      await ext.send({ kind: 'set-config', config: { hnUser: 'dataviz1000', tickMinutes: 1, retentionDays: 30 } });
      const mixed = {};
      Object.assign(mixed, seedReplies(20));
      const read = seedReplies(100, { allRead: true });
      // Bump ids in `read` so they don't collide with the unread batch
      for (const [, v] of Object.entries(read)) {
        v.id += 100_000;
        v.discoveredAt -= 3_600_000;
        mixed[String(v.id)] = v;
      }
      await ext.sw.evaluate(async (r) => chrome.storage.local.set({ replies: r }), mixed);
    },
  },
  {
    name: 'filter-read',
    async setup(ext) {
      await ext.send({ kind: 'reset-all' });
      await ext.send({ kind: 'set-config', config: { hnUser: 'dataviz1000', tickMinutes: 1, retentionDays: 30 } });
      const mixed = {};
      Object.assign(mixed, seedReplies(5));
      const read = seedReplies(8, { allRead: true });
      for (const [, v] of Object.entries(read)) { v.id += 100_000; mixed[String(v.id)] = v; }
      await ext.sw.evaluate(async (r) => chrome.storage.local.set({ replies: r }), mixed);
    },
    async tweak(page) {
      await page.getByRole('button', { name: /^read\s/ }).first().click();
      await page.waitForTimeout(150);
    },
  },
  {
    name: 'read-only',
    async setup(ext) {
      await ext.send({ kind: 'reset-all' });
      await ext.send({ kind: 'set-config', config: { hnUser: 'dataviz1000', tickMinutes: 1, retentionDays: 30 } });
      await ext.sw.evaluate(async (r) => chrome.storage.local.set({ replies: r }), seedReplies(1, { allRead: true, titles: false }));
    },
  },
  {
    name: 'settings',
    async setup(ext) {
      await ext.send({ kind: 'reset-all' });
      await ext.send({ kind: 'set-config', config: { hnUser: 'tptacek', tickMinutes: 15, retentionDays: 30 } });
      const mixed = {};
      Object.assign(mixed, seedReplies(3));
      const read = seedReplies(7, { allRead: true });
      for (const [, v] of Object.entries(read)) { v.id += 100_000; mixed[String(v.id)] = v; }
      await ext.sw.evaluate(async (r) => chrome.storage.local.set({ replies: r }), mixed);
    },
    async tweak(page) {
      await page.getByRole('button', { name: 'settings' }).first().click();
      await page.waitForTimeout(250);
    },
  },
  {
    name: 'confirm-modal',
    async setup(ext) {
      await ext.send({ kind: 'reset-all' });
      await ext.send({ kind: 'set-config', config: { hnUser: 'tptacek', tickMinutes: 15, retentionDays: 30 } });
      const mixed = {};
      Object.assign(mixed, seedReplies(3));
      const read = seedReplies(12, { allRead: true });
      for (const [, v] of Object.entries(read)) { v.id += 100_000; mixed[String(v.id)] = v; }
      await ext.sw.evaluate(async (r) => chrome.storage.local.set({ replies: r }), mixed);
    },
    async tweak(page) {
      await page.getByRole('button', { name: 'settings' }).first().click();
      await page.waitForTimeout(250);
      await page.waitForSelector('button.primary:has-text("clear") >> nth=0');
      await page.locator('button.primary:has-text("clear "):has-text("read")').first().click();
      await page.waitForTimeout(200);
    },
  },
  {
    name: 'unsaved-changes-modal',
    async setup(ext) {
      await ext.send({ kind: 'reset-all' });
      await ext.send({ kind: 'set-config', config: { hnUser: 'dataviz1000', tickMinutes: 5, retentionDays: 30 } });
    },
    async tweak(page) {
      await page.getByRole('button', { name: 'settings' }).first().click();
      await page.waitForTimeout(250);
      // Make a change so the form is dirty, then try to exit via "done"
      const input = page.locator('#hnUser');
      await input.fill('dataviz1001');
      await page.getByRole('button', { name: 'done' }).click();
      await page.waitForTimeout(200);
    },
  },
];

async function main() {
  console.log(`\nHNswered snapshot`);
  console.log(`label:    ${LABEL}`);
  console.log(`viewports: ${VIEWPORTS.map((v) => `${v.name}=${v.width}×${v.height}`).join(', ')}`);
  console.log(`output:   ${OUT}\n`);

  const ext = await launchWithExtension({ headless: HEADLESS });
  const results = [];
  try {
    for (const s of STATES) {
      process.stdout.write(`  ${s.name.padEnd(14)}`);
      await s.setup(ext);

      for (const vp of VIEWPORTS) {
        const page = await ext.openSidepanel({ viewport: { width: vp.width, height: vp.height } });
        if (s.tweak) await s.tweak(page);
        await page.waitForTimeout(400);

        const consoleErrors = [];
        page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

        const foldPath = resolve(OUT, `${s.name}-${vp.name}-fold.png`);
        const fullPath = resolve(OUT, `${s.name}-${vp.name}-full.png`);
        await page.screenshot({ path: foldPath, fullPage: false });
        await page.screenshot({ path: fullPath, fullPage: true });

        const dom = await page.evaluate(() => ({
          title: document.title,
          replyCount: document.querySelectorAll('.reply').length,
          topbarHeight: document.querySelector('.topbar')?.getBoundingClientRect().height,
          topbarWrapped: (document.querySelector('.topbar')?.getBoundingClientRect().height ?? 0) > 28,
          empty: document.querySelector('.empty')?.textContent?.trim() ?? null,
        }));

        results.push({
          state: s.name,
          viewport: vp.name,
          size: `${vp.width}x${vp.height}`,
          foldPath,
          fullPath,
          dom,
          consoleErrors,
        });
        await page.close();
      }
      console.log(` ✓`);
    }
  } finally {
    await ext.close();
  }

  const summary = { label: LABEL, timestamp: new Date().toISOString(), viewports: VIEWPORTS, results };
  writeFileSync(resolve(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(`\nsummary: ${resolve(OUT, 'summary.json')}`);

  // Quick table
  console.log('\n  state          narrow bar   wide bar   replies');
  for (const s of STATES) {
    const n = results.find((r) => r.state === s.name && r.viewport === 'narrow');
    const w = results.find((r) => r.state === s.name && r.viewport === 'wide');
    console.log(`  ${s.name.padEnd(14)} ${String(n?.dom.topbarHeight ?? '?').padStart(6)}px     ${String(w?.dom.topbarHeight ?? '?').padStart(4)}px     ${n?.dom.replyCount ?? '?'}`);
  }
  console.log('');
}

main().catch((err) => {
  console.error('snapshot failed:', err);
  process.exit(1);
});
