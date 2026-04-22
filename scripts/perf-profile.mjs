#!/usr/bin/env node
/**
 * Performance profiling for the HNswered side panel.
 *
 * Uses CDP via Playwright to measure render time and hot functions across
 * varying reply-list sizes: 1, 10, 100, 1000. Also measures one cold/warm
 * tick() call against a fake-populated monitored set.
 *
 * Output: .perf/<label>/results.json
 *
 * Usage:
 *   node scripts/perf-profile.mjs [--label=baseline]
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
const LABEL = args.label ?? `perf-${Date.now()}`;
const OUT = resolve(REPO, '.perf', LABEL);
mkdirSync(OUT, { recursive: true });

const SIZES = (args.sizes ?? '1,10,100,1000').split(',').map(Number);

function getMetric(m, name) {
  const x = m.metrics.find((e) => e.name === name);
  return x ? x.value : 0;
}
function metricsDelta(before, after) {
  return {
    scriptDuration_ms: (
      (getMetric(after, 'ScriptDuration') - getMetric(before, 'ScriptDuration')) * 1000
    ).toFixed(2),
    layoutCount: getMetric(after, 'LayoutCount') - getMetric(before, 'LayoutCount'),
    recalcStyleCount: getMetric(after, 'RecalcStyleCount') - getMetric(before, 'RecalcStyleCount'),
    domNodes: getMetric(after, 'Nodes'),
  };
}
function topFunctions(profile, limit = 10) {
  if (!profile || !profile.nodes || !profile.samples) return [];
  const idToNode = new Map();
  for (const n of profile.nodes) idToNode.set(n.id, n);
  const counts = new Map();
  for (const sid of profile.samples) {
    const n = idToNode.get(sid);
    if (!n) continue;
    const cf = n.callFrame;
    const file = cf.url ? cf.url.split('/').pop() : '(anon)';
    const key = `${cf.functionName || '(anonymous)'} (${file}:${cf.lineNumber})`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const total = profile.samples.length;
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, samples]) => ({ name, samples, pct: ((samples / total) * 100).toFixed(1) }));
}

function seedReplies(n) {
  const now = Date.now();
  const out = {};
  for (let i = 0; i < n; i++) {
    out[String(10_000_000 + i)] = {
      id: 10_000_000 + i,
      parentItemId: 42_000_000 + (i % 10),
      parentItemTitle: `Post ${i % 10}`,
      author: `user${i % 20}`,
      text: `<p>Reply ${i}</p>`,
      time: now - i * 60_000,
      read: false,
      discoveredAt: now - i * 30_000,
    };
  }
  return out;
}

async function profileRender(ext, size) {
  await ext.send({ kind: 'reset-all' });
  await ext.send({ kind: 'set-config', config: { hnUser: 'demo', tickMinutes: 5 } });
  await ext.sw.evaluate(async (r) => chrome.storage.local.set({ replies: r }), seedReplies(size));

  const page = await ext.context.newPage();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  await cdp.send('Profiler.enable');

  const t0 = Date.now();
  const before = await cdp.send('Performance.getMetrics');
  await cdp.send('Profiler.start');

  await page.goto(`chrome-extension://${ext.extensionId}/sidepanel.html`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.reply, .empty, .status', { timeout: 10_000 });
  await page.waitForTimeout(200);

  const { profile } = await cdp.send('Profiler.stop');
  const after = await cdp.send('Performance.getMetrics');
  const elapsed = Date.now() - t0;
  await cdp.detach();
  await page.close();

  return {
    size,
    elapsed_ms: elapsed,
    metrics: metricsDelta(before, after),
    hotFunctions: topFunctions(profile, 10),
  };
}

async function main() {
  console.log(`\nHNswered perf-profile`);
  console.log(`label:   ${LABEL}`);
  console.log(`sizes:   ${SIZES.join(', ')}`);
  console.log(`output:  ${OUT}\n`);

  const ext = await launchWithExtension({ headless: true });
  const results = [];
  try {
    for (const size of SIZES) {
      process.stdout.write(`  render ${String(size).padStart(5)}: `);
      const r = await profileRender(ext, size);
      results.push(r);
      console.log(
        `elapsed=${r.elapsed_ms}ms script=${r.metrics.scriptDuration_ms}ms nodes=${r.metrics.domNodes}`,
      );
    }
  } finally {
    await ext.close();
  }

  console.log('\n--- top hot functions (first size) ---');
  if (results[0]?.hotFunctions) {
    for (const f of results[0].hotFunctions.slice(0, 5)) {
      console.log(`  ${String(f.pct).padStart(5)}%  ${f.name}`);
    }
  }

  const summary = { label: LABEL, timestamp: new Date().toISOString(), sizes: SIZES, results };
  writeFileSync(resolve(OUT, 'results.json'), JSON.stringify(summary, null, 2));
  console.log(`\nresults: ${resolve(OUT, 'results.json')}\n`);
}

main().catch((err) => {
  console.error('perf-profile failed:', err);
  process.exit(1);
});
