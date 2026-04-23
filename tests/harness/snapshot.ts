/**
 * Golden-file snapshot assertions for harness scenarios.
 *
 * Per-step snapshot of the storage state, compared against a committed JSON
 * file under tests/harness/golden/<scenario>/<step>.json. Run with
 * HARNESS_UPDATE_GOLDEN=1 to (re)write goldens from current behavior — review
 * the diff in PR before committing.
 *
 * Stable JSON: object keys are sorted recursively so unrelated reorderings
 * don't produce noisy diffs.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLDEN_ROOT = resolve(__dirname, 'golden');

const UPDATE_ENV = process.env.HARNESS_UPDATE_GOLDEN === '1';

export interface GoldenOptions {
  /** Force write-mode for this call regardless of HARNESS_UPDATE_GOLDEN.
   *  Used by the recorder so a fresh tape implicitly seeds matching goldens. */
  write?: boolean;
}

export function expectGolden(scenario: string, step: string, snapshot: unknown, opts: GoldenOptions = {}): void {
  const dir = resolve(GOLDEN_ROOT, scenario);
  const file = resolve(dir, `${step}.json`);
  const text = stableStringify(snapshot) + '\n';
  const writeMode = opts.write || UPDATE_ENV;

  if (writeMode) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, text, 'utf-8');
    return;
  }

  if (!existsSync(file)) {
    throw new Error(
      `Golden file missing: ${file}\nRun with HARNESS_UPDATE_GOLDEN=1 to create it.`,
    );
  }
  const expected = readFileSync(file, 'utf-8');
  assert.equal(text, expected, `Golden mismatch for ${scenario}/${step}.\nRun with HARNESS_UPDATE_GOLDEN=1 to update if the change is intentional.`);
}

function stableStringify(value: unknown, indent = 2): string {
  return JSON.stringify(value, replacer, indent);
}

function replacer(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = (value as Record<string, unknown>)[k];
    }
    return sorted;
  }
  return value;
}
