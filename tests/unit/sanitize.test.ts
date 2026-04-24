import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';

let sanitizeCommentHtml: (raw: string) => string;

before(async () => {
  const window = new Window();
  (globalThis as unknown as { document: Document }).document =
    window.document as unknown as Document;
  (globalThis as unknown as { Node: typeof Node }).Node =
    window.Node as unknown as typeof Node;
  ({ sanitizeCommentHtml } = await import('../../src/sidepanel/lib/sanitize.ts'));
});

test('empty input → empty output', () => {
  assert.equal(sanitizeCommentHtml(''), '');
});

test('plain text passes through', () => {
  assert.equal(sanitizeCommentHtml('hello world'), 'hello world');
});

test('drops <script> but keeps surrounding text', () => {
  const out = sanitizeCommentHtml('<script>alert(1)</script>hi');
  assert.ok(!out.includes('<script'), 'no script tag');
  assert.ok(!out.includes('alert'), 'no script body');
  assert.ok(out.includes('hi'), 'text preserved');
});

test('drops <img> with onerror', () => {
  const out = sanitizeCommentHtml('<img src=x onerror=alert(1)>');
  assert.ok(!out.includes('<img'), 'no img');
  assert.ok(!out.includes('onerror'), 'no onerror attr');
  assert.ok(!out.includes('alert'), 'no handler body');
});

test('drops <svg><script>', () => {
  const out = sanitizeCommentHtml('<svg><script>alert(1)</script></svg>');
  assert.ok(!out.includes('<svg'), 'no svg');
  assert.ok(!out.includes('<script'), 'no nested script');
  assert.ok(!out.includes('alert'), 'no handler body');
});

test('drops javascript: href, keeps anchor shell', () => {
  const out = sanitizeCommentHtml('<a href="javascript:alert(1)">x</a>');
  assert.ok(out.includes('<a'), 'anchor preserved');
  assert.ok(!out.includes('javascript:'), 'javascript: scheme dropped');
  assert.ok(!out.includes('alert'), 'no handler body');
  assert.ok(out.includes('>x</a>'), 'child text preserved');
});

test('drops mixed-case JaVaScRiPt: href', () => {
  const out = sanitizeCommentHtml('<a href="JaVaScRiPt:alert(1)">x</a>');
  assert.ok(!/javascript:/i.test(out), 'no javascript: in any case');
  assert.ok(!out.includes('alert'));
});

test('drops entity-encoded javascript: href', () => {
  const out = sanitizeCommentHtml('<a href="&#106;avascript:alert(1)">x</a>');
  assert.ok(!/javascript:/i.test(out), 'entity-decoded scheme dropped');
  assert.ok(!out.includes('alert'));
});

test('drops whitespace-prefixed javascript: href', () => {
  const out = sanitizeCommentHtml('<a href=" \tjavascript:alert(1)">x</a>');
  assert.ok(!/javascript:/i.test(out));
  assert.ok(!out.includes('alert'));
});

test('drops data: href', () => {
  const out = sanitizeCommentHtml(
    '<a href="data:text/html,<script>alert(1)</script>">x</a>',
  );
  assert.ok(!out.includes('data:'), 'no data: scheme');
  assert.ok(!out.includes('<script'));
});

test('drops vbscript: href', () => {
  const out = sanitizeCommentHtml('<a href="vbscript:msgbox(1)">x</a>');
  assert.ok(!out.includes('vbscript:'));
});

test('drops protocol-relative //host href (tightened policy — HN never emits these)', () => {
  const out = sanitizeCommentHtml('<a href="//evil.example/p">x</a>');
  assert.ok(!out.includes('evil.example'), 'protocol-relative href dropped');
});

test('drops root-relative /path href (HN never emits these)', () => {
  const out = sanitizeCommentHtml('<a href="/admin">x</a>');
  assert.ok(!out.includes('/admin'), 'root-relative href dropped');
});

test('keeps http:// href', () => {
  const out = sanitizeCommentHtml('<a href="http://example.com/p">x</a>');
  assert.ok(out.includes('href="http://example.com/p"'));
  assert.ok(out.includes('rel="noopener noreferrer"'), 'rel forced');
  assert.ok(out.includes('target="_blank"'), 'target forced');
});

test('keeps https:// href', () => {
  const out = sanitizeCommentHtml('<a href="https://example.com/p">x</a>');
  assert.ok(out.includes('href="https://example.com/p"'));
});

test('strips onclick on allowed tag', () => {
  const out = sanitizeCommentHtml('<p onclick="alert(1)">x</p>');
  assert.ok(out.includes('<p'), 'p preserved');
  assert.ok(!out.includes('onclick'), 'onclick dropped');
  assert.ok(!out.includes('alert'));
});

test('strips script nested inside allowed anchor', () => {
  const out = sanitizeCommentHtml(
    '<a href="http://x"><script>alert(1)</script></a>',
  );
  assert.ok(out.includes('href="http://x"'));
  assert.ok(!out.includes('<script'));
  assert.ok(!out.includes('alert'));
});

test('keeps full HN allowlist tags', () => {
  const out = sanitizeCommentHtml(
    '<p><i>i</i><b>b</b><em>e</em><strong>s</strong><pre><code>c</code></pre></p>',
  );
  for (const tag of ['p', 'i', 'b', 'em', 'strong', 'pre', 'code']) {
    assert.ok(out.includes(`<${tag}>`), `${tag} preserved`);
  }
});

test('drops iframe entirely', () => {
  const out = sanitizeCommentHtml('<iframe src="http://evil"></iframe>hi');
  assert.ok(!out.includes('<iframe'));
  assert.ok(!out.includes('evil'));
  assert.ok(out.includes('hi'));
});

test('unwraps disallowed wrapper, preserves child text', () => {
  const out = sanitizeCommentHtml('<div>hello <b>world</b></div>');
  assert.ok(!out.includes('<div'), 'div dropped');
  assert.ok(out.includes('hello'), 'text preserved');
  assert.ok(out.includes('<b>world</b>'), 'allowed child preserved');
});
