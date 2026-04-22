<script lang="ts">
  import type { Reply } from '../../../shared/types.ts';
  import { timeAgo } from '../time.ts';
  import { api } from '../api.ts';
  import { sanitizeCommentHtml } from '../sanitize.ts';

  interface Props {
    reply: Reply;
  }
  let { reply }: Props = $props();
  const safeHtml = $derived(sanitizeCommentHtml(reply.text || '<em>(no text)</em>'));
  const hnLink = $derived(`https://news.ycombinator.com/item?id=${reply.id}`);
  const parentLink = $derived(`https://news.ycombinator.com/item?id=${reply.parentItemId}`);

  async function open() {
    window.open(hnLink, '_blank', 'noopener');
    if (!reply.read) await api.markRead(reply.id);
  }
  async function markRead() {
    if (!reply.read) await api.markRead(reply.id);
  }
  async function openParent(e: MouseEvent) {
    e.preventDefault();
    window.open(parentLink, '_blank', 'noopener');
    if (!reply.read) await api.markRead(reply.id);
  }
</script>

<div class="reply" class:read={reply.read}>
  {#if reply.parentExcerpt}
    <a class="quoted" href={parentLink} target="_blank" rel="noopener" onclick={openParent}>
      <span class="quote-author">{reply.parentAuthor ?? 'parent'}</span>
      <span class="quote-text">{reply.parentExcerpt}</span>
    </a>
  {:else if reply.parentItemTitle}
    <a class="quoted story" href={parentLink} target="_blank" rel="noopener" onclick={openParent}>
      <span class="quote-text">{reply.parentItemTitle}</span>
    </a>
  {/if}
  <div class="meta">
    <strong>{reply.author}</strong>
    <span class="dot">·</span>
    <a href={hnLink} onclick={(e) => { e.preventDefault(); open(); }}>{timeAgo(reply.time)}</a>
  </div>
  <div class="text">{@html safeHtml}</div>
  <div class="actions">
    <a href={hnLink} onclick={(e) => { e.preventDefault(); open(); }}>open on hn</a>
    {#if !reply.read}
      <span class="dot">·</span>
      <button type="button" onclick={markRead}>mark read</button>
    {/if}
  </div>
</div>
