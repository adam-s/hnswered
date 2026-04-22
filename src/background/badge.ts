export async function updateBadge(unreadCount: number): Promise<void> {
  const text = unreadCount > 0 ? (unreadCount > 99 ? '99+' : String(unreadCount)) : '';
  await chrome.action.setBadgeText({ text });
  if (unreadCount > 0) {
    await chrome.action.setBadgeBackgroundColor({ color: '#2d7d7d' });
    await chrome.action.setBadgeTextColor({ color: '#ffffff' });
  }
}
