/**
 * CLI: record a scenario's HN traffic to a tape file.
 *
 * Usage:
 *   pnpm harness:record --scenario=first-configure
 *
 * Imports the named scenario file, runs scenario.run(driver) in RECORD mode
 * against live HN, and writes the resulting tape to
 * tests/harness/fixtures/<scenario>/tape.json.
 *
 * Politeness: requests go through the unmodified production hn-client, which
 * already inserts FETCH.PER_REQUEST_DELAY_MS between item fetches. A first-
 * configure scenario is bounded to roughly 30-60 requests against /v0/.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDriver } from './driver.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = resolve(__dirname, 'fixtures');

interface Args {
  scenario: string;
}

function parseArgs(): Args {
  const out: Record<string, string> = {};
  for (const a of process.argv.slice(2)) {
    if (!a.startsWith('--')) continue;
    const [k, v] = a.replace(/^--/, '').split('=');
    out[k] = v ?? 'true';
  }
  if (!out.scenario) {
    console.error('Usage: pnpm harness:record --scenario=<name>');
    process.exit(2);
  }
  return { scenario: out.scenario };
}

async function main() {
  const args = parseArgs();
  console.log(`recording scenario: ${args.scenario}`);
  console.log('  hitting live HN — this will take a few seconds.');

  // Dynamic import of the scenario definition file (NOT the .test.ts wrapper —
  // that one would self-register a node:test test as a side effect of import).
  const scenarioModule = await import(`./scenarios/${args.scenario}.ts`);
  const scenarioDef = scenarioModule.scenario;
  if (!scenarioDef || typeof scenarioDef.run !== 'function') {
    console.error(`scenario file did not export a { name, user, run } scenario object`);
    process.exit(1);
  }

  const tapePath = resolve(FIXTURES_ROOT, args.scenario, 'tape.json');
  mkdirSync(dirname(tapePath), { recursive: true });

  const driver = await createDriver({
    scenario: scenarioDef.name,
    user: scenarioDef.user,
    mode: 'record',
  });
  try {
    await scenarioDef.run(driver);
  } finally {
    await driver.uninstall();
  }

  writeFileSync(tapePath, JSON.stringify(driver.tape, null, 2) + '\n', 'utf-8');
  console.log(`  wrote tape: ${tapePath}`);
  console.log(`  recorded ${driver.tape.calls.length} HN calls`);
  console.log(`  recordedAt anchor: ${new Date(driver.tape.recordedAt).toISOString()} (${driver.tape.recordedAt})`);
  console.log('');
  console.log('next: HARNESS_UPDATE_GOLDEN=1 pnpm harness:replay   # seed goldens from this tape');
}

main().catch((err) => {
  console.error('record failed:', err);
  process.exit(1);
});
