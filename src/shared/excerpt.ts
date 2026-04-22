/**
 * Strip HTML tags and collapse whitespace; truncate at the first word boundary
 * past `maxChars`. Ellipsis appended only if truncated.
 */
export function excerptFrom(html: string | undefined | null, maxChars = 140): string | undefined {
  if (!html) return undefined;
  const text = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim();
  if (!text) return undefined;
  if (text.length <= maxChars) return text;
  const sliced = text.slice(0, maxChars);
  const lastSpace = sliced.lastIndexOf(' ');
  const trimTo = lastSpace > maxChars * 0.6 ? lastSpace : maxChars;
  return text.slice(0, trimTo).trimEnd() + '…';
}
