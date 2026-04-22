const MIN = 60_000;
const HR = 60 * MIN;
const DAY = 24 * HR;

export function timeAgo(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts);
  if (diff < MIN) return 'just now';
  if (diff < HR) return `${Math.floor(diff / MIN)} minutes ago`;
  if (diff < DAY) return `${Math.floor(diff / HR)} hours ago`;
  return `${Math.floor(diff / DAY)} days ago`;
}
