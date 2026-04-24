/**
 * Minimal HTML sanitizer for HN comment text.
 * HN allows a small tag set in comments: <a>, <i>, <b>, <p>, <pre>, <code>.
 * We parse with the DOM (native, safe) and rebuild an allowlist subtree.
 * This runs in the sidepanel document context.
 */

const ALLOWED_TAGS = new Set(['A', 'I', 'B', 'P', 'PRE', 'CODE', 'BR', 'EM', 'STRONG']);
// Drop entirely (tag + all descendants) — otherwise their text content would
// leak into rendered output via the unwrap-and-preserve-text fallback.
const DROP_TREE_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'NOEMBED',
  'TEMPLATE',
  'IFRAME',
  'OBJECT',
  'EMBED',
]);

function safeHref(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (/^https?:/i.test(trimmed)) return trimmed;
  return null;
}

function clone(src: Node, parent: Node, doc: Document) {
  if (src.nodeType === Node.TEXT_NODE) {
    parent.appendChild(doc.createTextNode(src.textContent ?? ''));
    return;
  }
  if (src.nodeType !== Node.ELEMENT_NODE) return;
  const el = src as Element;
  const tag = el.tagName.toUpperCase();
  if (DROP_TREE_TAGS.has(tag)) return;
  if (!ALLOWED_TAGS.has(tag)) {
    for (const child of Array.from(el.childNodes)) clone(child, parent, doc);
    return;
  }
  const out = doc.createElement(tag.toLowerCase());
  if (tag === 'A') {
    const href = safeHref(el.getAttribute('href'));
    if (href) out.setAttribute('href', href);
    out.setAttribute('rel', 'noopener noreferrer');
    out.setAttribute('target', '_blank');
  }
  for (const child of Array.from(el.childNodes)) clone(child, out, doc);
  parent.appendChild(out);
}

export function sanitizeCommentHtml(raw: string): string {
  if (!raw) return '';
  const tpl = document.createElement('template');
  tpl.innerHTML = raw;
  const out = document.createElement('div');
  for (const child of Array.from(tpl.content.childNodes)) clone(child, out, document);
  return out.innerHTML;
}
