/**
 * Minimal HTML sanitizer for HN comment text.
 * HN allows a small tag set in comments: <a>, <i>, <b>, <p>, <pre>, <code>.
 * We parse with the DOM (native, safe) and rebuild an allowlist subtree.
 * This runs in the sidepanel document context.
 */

const ALLOWED_TAGS = new Set(['A', 'I', 'B', 'P', 'PRE', 'CODE', 'BR', 'EM', 'STRONG']);

function safeHref(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  // Allow only http(s), explicit relative, or protocol-less URLs.
  if (/^https?:/i.test(trimmed)) return trimmed;
  if (/^\/\//.test(trimmed)) return 'https:' + trimmed;
  if (/^\//.test(trimmed)) return trimmed;
  return null; // drop javascript:, data:, vbscript:, etc.
}

function clone(src: Node, parent: Node, doc: Document) {
  if (src.nodeType === Node.TEXT_NODE) {
    parent.appendChild(doc.createTextNode(src.textContent ?? ''));
    return;
  }
  if (src.nodeType !== Node.ELEMENT_NODE) return;
  const el = src as Element;
  const tag = el.tagName.toUpperCase();
  if (!ALLOWED_TAGS.has(tag)) {
    // Drop the wrapper but preserve its text children (HN wraps paragraphs in <p>).
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
