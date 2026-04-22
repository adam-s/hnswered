import { test } from 'node:test';
import assert from 'node:assert/strict';
import { excerptFrom } from '../../src/shared/excerpt.ts';

test('returns undefined for empty/null', () => {
  assert.equal(excerptFrom(''), undefined);
  assert.equal(excerptFrom(undefined), undefined);
  assert.equal(excerptFrom(null), undefined);
  assert.equal(excerptFrom('   '), undefined);
});

test('strips tags and collapses whitespace', () => {
  assert.equal(
    excerptFrom('<p>Hello  <i>world</i>.</p><p>Second line.</p>'),
    'Hello world. Second line.',
  );
});

test('decodes common HTML entities', () => {
  assert.equal(excerptFrom('&amp; &lt;x&gt; &quot;y&quot; &#x27;z&#x27;'), '& <x> "y" \'z\'');
});

test('truncates long text at word boundary with ellipsis', () => {
  const long = 'alpha beta gamma delta '.repeat(20); // ~460 chars
  const out = excerptFrom(long, 60);
  assert.ok(out && out.length <= 61, `expected <=61 chars, got ${out?.length}`);
  assert.ok(out?.endsWith('…'), 'expected ellipsis');
  assert.ok(!out?.match(/ $/), 'no trailing space before ellipsis');
});

test('returns text unchanged when under limit', () => {
  assert.equal(excerptFrom('short'), 'short');
});

test('does not inject HTML (tags stripped, entities decoded only to text — rendered as text in UI)', () => {
  // This output is placed as TEXT (not @html) in ReplyRow — so even if it contained
  // angle brackets, Svelte would escape them. Verify the helper produces only safe text.
  const malicious = '<script>alert(1)</script> then <a href="javascript:alert(2)">click</a>';
  const out = excerptFrom(malicious);
  assert.ok(!out?.includes('<'), 'stripped angle brackets');
  assert.ok(!out?.includes('javascript:'), 'href stripped with tag');
});
