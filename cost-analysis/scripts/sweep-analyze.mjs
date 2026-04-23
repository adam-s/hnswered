// Stage 2 analyzer — reads cost-analysis/data/<label>/sweep.jsonl and
// crosscheck.jsonl, emits report.md with per-window quantile tables
// stratified by parent type and score class, plus Algolia-vs-Firebase
// agreement metrics.
//
// Run: node cost-analysis/scripts/sweep-analyze.mjs --label=full-01

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  }),
);

const label = args.label;
if (!label) {
  console.error('usage: sweep-analyze.mjs --label=<name>');
  process.exit(1);
}

const OUT = join(process.cwd(), 'cost-analysis', 'data', label);

function readJsonl(path) {
  try {
    return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function quantiles(vals) {
  if (!vals.length) return null;
  const sorted = [...vals].sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
  const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length;
  return {
    n: sorted.length,
    min: sorted[0],
    p50: q(0.5),
    p75: q(0.75),
    p90: q(0.9),
    p95: q(0.95),
    p99: q(0.99),
    max: sorted[sorted.length - 1],
    mean,
  };
}

function scoreClass(points) {
  if (points == null) return 'na';
  if (points < 5) return '0-4';
  if (points < 20) return '5-19';
  if (points < 100) return '20-99';
  if (points < 500) return '100-499';
  return '500+';
}

function tableRow(label, q) {
  if (!q) return `| ${label} | — | — | — | — | — | — | — | — |`;
  return `| ${label} | ${q.n} | ${q.p50} | ${q.p75} | ${q.p90} | ${q.p95} | ${q.p99} | ${q.max} | ${q.mean.toFixed(2)} |`;
}

const WINDOWS = ['30m', '1h', '6h', '1d', '1w', '2w', '1m', '3m'];

function main() {
  const sweepPath = join(OUT, 'sweep.jsonl');
  const crossPath = join(OUT, 'crosscheck.jsonl');
  const summaryPath = join(OUT, 'summary.json');

  const sweep = readJsonl(sweepPath);
  const cross = readJsonl(crossPath);
  if (!sweep.length) {
    console.error(`no sweep data at ${sweepPath}`);
    process.exit(1);
  }
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));

  const byType = {};
  for (const r of sweep) {
    (byType[r.parent_type] ??= []).push(r);
  }

  const windowTable = (rows, window) => {
    const vals = rows.map((r) => r.window_counts[window]).filter((v) => v != null);
    return quantiles(vals);
  };

  const lines = [];
  lines.push(`# Retrospective sweep report — \`${label}\``);
  lines.push('');
  lines.push(`Generated ${new Date().toISOString()}.`);
  lines.push('');
  lines.push('Counts below are **direct replies** (not descendants of descendants) to a single parent, cumulative within the age window measured from parent\'s `created_at`. `null` window counts (parent not yet old enough to have observed the window) are excluded from quantile computation.');
  lines.push('');
  lines.push('## Sweep overview');
  lines.push('');
  lines.push(`- Parents sampled: ${sweep.length} (requested ${summary.inputs?.totalParents ?? '?'})`);
  lines.push(`- Parent types: ${Object.entries(byType).map(([t, rs]) => `${t}=${rs.length}`).join(', ')}`);
  lines.push(`- Wall time: ${((summary.wall_ms ?? 0) / 1000).toFixed(1)}s`);
  lines.push(`- Total HTTP requests: ${summary.total_requests ?? '?'}`);
  lines.push(`- Throttles (403/429/5xx retries): ${summary.throttles_count ?? 0}`);
  lines.push(`- Failures: ${summary.failures_count ?? 0}`);
  lines.push('');
  lines.push('## Reply counts per window by parent type');
  lines.push('');

  for (const [type, rows] of Object.entries(byType)) {
    lines.push(`### \`${type}\` parents (n=${rows.length})`);
    lines.push('');
    lines.push('| Window | n | p50 | p75 | p90 | p95 | p99 | max | mean |');
    lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
    for (const w of WINDOWS) {
      lines.push(tableRow(w, windowTable(rows, w)));
    }
    lines.push('');
  }

  // Score-class stratification (stories only — comments don't have points).
  const stories = byType.story ?? [];
  if (stories.length) {
    lines.push('## Story reply counts stratified by score class');
    lines.push('');
    const buckets = ['0-4', '5-19', '20-99', '100-499', '500+'];
    for (const sc of buckets) {
      const rows = stories.filter((r) => scoreClass(r.points) === sc);
      if (!rows.length) continue;
      lines.push(`### score \`${sc}\` (n=${rows.length})`);
      lines.push('');
      lines.push('| Window | n | p50 | p75 | p90 | p95 | p99 | max | mean |');
      lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
      for (const w of WINDOWS) {
        lines.push(tableRow(w, windowTable(rows, w)));
      }
      lines.push('');
    }
  }

  // Distribution: fraction of parents with 0, 1-5, 6-20, 21+ replies.
  lines.push('## Reply-count distribution by window (fraction of parents)');
  lines.push('');
  for (const [type, rows] of Object.entries(byType)) {
    lines.push(`### \`${type}\` (n=${rows.length})`);
    lines.push('');
    lines.push('| Window | n | =0 | 1-5 | 6-20 | 21-100 | 101+ |');
    lines.push('|---|---:|---:|---:|---:|---:|---:|');
    for (const w of WINDOWS) {
      const vals = rows.map((r) => r.window_counts[w]).filter((v) => v != null);
      if (!vals.length) {
        lines.push(`| ${w} | 0 | — | — | — | — | — |`);
        continue;
      }
      const n = vals.length;
      const zero = vals.filter((v) => v === 0).length;
      const oneFive = vals.filter((v) => v >= 1 && v <= 5).length;
      const sixTwenty = vals.filter((v) => v >= 6 && v <= 20).length;
      const twentyonehund = vals.filter((v) => v >= 21 && v <= 100).length;
      const hundredplus = vals.filter((v) => v >= 101).length;
      const p = (x) => `${((x / n) * 100).toFixed(1)}%`;
      lines.push(`| ${w} | ${n} | ${p(zero)} | ${p(oneFive)} | ${p(sixTwenty)} | ${p(twentyonehund)} | ${p(hundredplus)} |`);
    }
    lines.push('');
  }

  // Agreement.
  if (cross.length) {
    const liveAgreement =
      cross.reduce((s, r) => s + (r.firebase_live_count > 0 ? r.intersect / r.firebase_live_count : 1), 0) / cross.length;
    const rawAgreement =
      cross.reduce((s, r) => s + (r.firebase_raw_count > 0 ? r.intersect / r.firebase_raw_count : 1), 0) / cross.length;
    const perfect = cross.filter((r) => r.algolia_only === 0 && r.firebase_only_live === 0).length / cross.length;
    const totalAlgOnly = cross.reduce((s, r) => s + r.algolia_only, 0);
    const totalFbOnlyLive = cross.reduce((s, r) => s + r.firebase_only_live, 0);
    const totalDeadFiltered = cross.reduce((s, r) => s + r.firebase_only_dead_or_deleted, 0);

    lines.push('## Algolia vs Firebase cross-check');
    lines.push('');
    lines.push(`- Parents cross-checked: ${cross.length}`);
    lines.push(`- **Live agreement rate**: ${(liveAgreement * 100).toFixed(2)}% (Algolia ∩ Firebase / Firebase-live, per parent, averaged)`);
    lines.push(`- Raw agreement rate: ${(rawAgreement * 100).toFixed(2)}% (includes dead/deleted in Firebase)`);
    lines.push(`- Perfect matches (no disagreement either way): ${(perfect * 100).toFixed(2)}%`);
    lines.push(`- Algolia-only IDs across all parents: ${totalAlgOnly} (should be 0 if Algolia's \`parent_id\` is sound)`);
    lines.push(`- Firebase-only live (Algolia truly missed): ${totalFbOnlyLive}`);
    lines.push(`- Firebase-only dead/deleted (Algolia excluded by design): ${totalDeadFiltered}`);
    lines.push('');
  }

  const reportPath = join(OUT, 'report.md');
  writeFileSync(reportPath, lines.join('\n'));
  console.log(`report → ${reportPath}`);
}

main();
