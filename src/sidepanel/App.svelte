<script lang="ts">
  import type { Config, Reply } from '../shared/types.ts';
  import { api, onStorageChanged } from './lib/api.ts';
  import ReplyRow from './lib/components/ReplyRow.svelte';
  import Settings from './lib/components/Settings.svelte';
  import { onMount } from 'svelte';
  import { RETENTION } from '../shared/constants.ts';

  type Filter = 'all' | 'unread' | 'read';

  let view: 'list' | 'settings' = $state('list');
  let replies: Reply[] = $state([]);
  let config: Config = $state({ hnUser: '', tickMinutes: 5, retentionDays: 30 });
  let loading = $state(true);
  let filter: Filter = $state('unread');
  let renderLimit = $state(RETENTION.PAGE_SIZE);

  async function refresh() {
    const [r, c] = await Promise.all([api.listReplies(), api.getConfig()]);
    replies = r;
    config = c;
    loading = false;
  }

  onMount(() => {
    refresh();
    const off = onStorageChanged(() => refresh());
    return off;
  });

  const unreadCount = $derived(replies.filter((r) => !r.read).length);
  const readCount = $derived(replies.length - unreadCount);
  const filtered = $derived(
    filter === 'all' ? replies
    : filter === 'unread' ? replies.filter((r) => !r.read)
    : replies.filter((r) => r.read),
  );
  const visible = $derived(filtered.slice(0, renderLimit));
  const hiddenCount = $derived(Math.max(0, filtered.length - visible.length));

  function setFilter(f: Filter) {
    if (filter !== f) {
      filter = f;
      renderLimit = RETENTION.PAGE_SIZE; // reset paging on filter change
    }
  }

  async function markAll() { await api.markAllRead(); }
  async function onRefreshClick() { await api.forceRefresh(); }
  function showSettings() { view = 'settings'; }
  function showList() { view = 'list'; refresh(); }
  function loadMore() { renderLimit += RETENTION.PAGE_SIZE; }

  // Route the topbar "done" click through Settings so it can prompt on unsaved changes.
  let settingsRef: { requestDone: () => void } | undefined = $state();
  function onDoneClick() {
    if (settingsRef) settingsRef.requestDone();
    else showList();
  }
</script>

<div class="topbar">
  {#if view === 'list'}
    <span class="who">
{#if config.hnUser}
        <span class="dim">watching</span> <strong>{config.hnUser}</strong>
      {:else}
        <span class="dim">no user configured</span>
      {/if}
    </span>
    <span class="verbs">
      {#if config.hnUser}
        <button type="button" onclick={onRefreshClick}>refresh</button>
        <span class="dot">·</span>
        <button type="button" onclick={markAll} disabled={unreadCount === 0}>mark all</button>
        <span class="dot">·</span>
      {/if}
      <button type="button" onclick={showSettings}>settings</button>
    </span>
  {:else}
    <span class="who">
<span class="dim">settings</span>
    </span>
    <span class="verbs">
      <button type="button" onclick={onDoneClick}>done</button>
    </span>
  {/if}
</div>

{#if view === 'list' && config.hnUser}
  <div class="subbar">
    <button type="button" class:active={filter === 'all'} onclick={() => setFilter('all')}>
      all <span class="count">{replies.length}</span>
    </button>
    <span class="sep">|</span>
    <button type="button" class:active={filter === 'unread'} onclick={() => setFilter('unread')}>
      unread <span class="count">{unreadCount}</span>
    </button>
    <span class="sep">|</span>
    <button type="button" class:active={filter === 'read'} onclick={() => setFilter('read')}>
      read <span class="count">{readCount}</span>
    </button>
  </div>
{/if}

{#if view === 'settings'}
  <Settings {config} onDone={showList} bind:this={settingsRef} />
{:else}
  <div class="body">
    {#if loading}
      <div class="status">loading…</div>
    {:else if !config.hnUser}
      <div class="empty">
        No HN username configured. <a href="#" onclick={(e) => { e.preventDefault(); showSettings(); }}>Configure →</a>
      </div>
    {:else if filtered.length === 0}
      <div class="empty">
        {#if filter === 'unread'}No new replies.{:else if filter === 'read'}Nothing read yet.{:else}No replies.{/if}
      </div>
    {:else}
      {#each visible as r (r.id)}
        <ReplyRow reply={r} />
      {/each}
      {#if hiddenCount > 0}
        <div class="more"><a href="#" onclick={(e) => { e.preventDefault(); loadMore(); }}>More</a></div>
      {/if}
    {/if}
  </div>
{/if}
