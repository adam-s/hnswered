<script lang="ts">
  import type { Config, StorageStats } from '../../../shared/types.ts';
  import { api } from '../api.ts';
  import { onMount } from 'svelte';
  import Confirm from './Confirm.svelte';

  interface Props {
    config: Config;
    onDone: () => void;
  }
  let { config, onDone }: Props = $props();

  // Captured once at mount. Settings unmounts when the view flips back to list, so
  // these are stable for the component's lifetime.
  const initialHnUser = config.hnUser;
  const initialTick = config.tickMinutes;
  const initialRetention = config.retentionDays ?? 30;

  // svelte-ignore state_referenced_locally
  let hnUser = $state(config.hnUser);
  // svelte-ignore state_referenced_locally
  let tickMinutes = $state(config.tickMinutes);
  // svelte-ignore state_referenced_locally
  let retentionDays = $state(config.retentionDays ?? 30);
  let saving = $state(false);
  let stats: StorageStats | null = $state(null);
  let clearingRead = $state(false);
  let clearingAll = $state(false);
  let modal: 'none' | 'clear-read' | 'clear-all' | 'unsaved-changes' = $state('none');

  const dirty = $derived(
    hnUser.trim() !== initialHnUser.trim() ||
    tickMinutes !== initialTick ||
    retentionDays !== initialRetention,
  );

  const intervals = [1, 5, 15, 30, 60];
  const retentions = [7, 14, 30, 60, 90, 365];

  async function loadStats() {
    stats = await api.getStorageStats();
  }
  onMount(() => { void loadStats(); });

  async function performSave() {
    saving = true;
    try {
      await api.setConfig({ hnUser: hnUser.trim(), tickMinutes, retentionDays });
      if (hnUser.trim()) await api.forceTick();
    } finally {
      saving = false;
    }
  }

  async function save(e: Event) {
    e.preventDefault();
    await performSave();
    onDone();
  }

  // Called by the parent's topbar "done" button via bind:this.
  export function requestDone() {
    if (dirty) modal = 'unsaved-changes';
    else onDone();
  }

  async function saveAndDone() {
    modal = 'none';
    await performSave();
    onDone();
  }
  function discardAndDone() {
    modal = 'none';
    onDone();
  }

  function onClearRead() {
    if (!stats || stats.replyCount === stats.unreadCount) return;
    modal = 'clear-read';
  }
  async function doClearRead() {
    modal = 'none';
    clearingRead = true;
    try {
      await api.clearRead();
      await loadStats();
    } finally {
      clearingRead = false;
    }
  }

  function onClearAll() {
    if (!stats || stats.replyCount === 0) return;
    modal = 'clear-all';
  }
  async function doClearAll() {
    modal = 'none';
    clearingAll = true;
    try {
      await api.clearAllReplies();
      await loadStats();
    } finally {
      clearingAll = false;
    }
  }

  function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
  }
</script>

<div class="settings">
  <form onsubmit={save}>
    <div class="field">
      <label for="hnUser">hn username</label>
      <input id="hnUser" type="text" bind:value={hnUser} autocomplete="off" spellcheck="false" placeholder="e.g. dang" />
    </div>

    <div class="field">
      <label for="tick">poll every</label>
      <select id="tick" bind:value={tickMinutes}>
        {#each intervals as n}
          <option value={n}>{n} minute{n === 1 ? '' : 's'}</option>
        {/each}
      </select>
    </div>

    <div class="field">
      <label for="retention">drop read replies after</label>
      <select id="retention" bind:value={retentionDays}>
        {#each retentions as n}
          <option value={n}>{n} days</option>
        {/each}
      </select>
    </div>

    <p class="hint">
      Each poll hits <code>/v0/updates.json</code> first and only fetches items that changed.
      Background scans — daily for the past week, weekly for the past year — catch late replies
      and prune read replies past the retention window.
      Changing the username clears all stored replies so the new account starts fresh.
    </p>

    <button type="submit" class="primary" disabled={saving}>{saving ? 'saving…' : 'save'}</button>
  </form>

  <div class="storage">
    <div class="section-label">storage</div>
    {#if stats}
      <table class="kv">
        <tbody>
          <tr><td>replies</td><td>{stats.replyCount} ({stats.unreadCount} unread)</td></tr>
          <tr><td>monitored</td><td>{stats.monitoredCount}</td></tr>
          <tr><td>bytes used</td><td>{formatBytes(stats.bytesInUse)} / 10 MB</td></tr>
        </tbody>
      </table>
      <div class="storage-actions">
        {#if stats.replyCount > stats.unreadCount}
          <button type="button" class="primary" onclick={onClearRead} disabled={clearingRead}>
            {clearingRead ? 'clearing…' : `clear ${stats.replyCount - stats.unreadCount} read`}
          </button>
        {/if}
        {#if stats.replyCount > 0}
          <button type="button" class="primary" onclick={onClearAll} disabled={clearingAll}>
            {clearingAll ? 'clearing…' : `clear all ${stats.replyCount}`}
          </button>
        {/if}
      </div>
    {:else}
      <div class="status">loading…</div>
    {/if}
  </div>
</div>

{#if modal === 'clear-read' && stats}
  <Confirm
    title="drop read replies?"
    message={`Deletes ${stats.replyCount - stats.unreadCount} read ${stats.replyCount - stats.unreadCount === 1 ? 'reply' : 'replies'} from local storage. Unread are kept.`}
    confirmLabel="drop"
    cancelLabel="cancel"
    destructive
    onConfirm={doClearRead}
    onCancel={() => modal = 'none'}
  />
{:else if modal === 'clear-all' && stats}
  <Confirm
    title="drop all replies?"
    message={`Deletes all ${stats.replyCount} ${stats.replyCount === 1 ? 'reply' : 'replies'} from local storage, including ${stats.unreadCount} unread. Monitored items stay.`}
    confirmLabel="drop all"
    cancelLabel="cancel"
    destructive
    onConfirm={doClearAll}
    onCancel={() => modal = 'none'}
  />
{:else if modal === 'unsaved-changes'}
  <Confirm
    title="save changes?"
    message="You have unsaved settings edits."
    confirmLabel="save"
    secondaryLabel="discard"
    cancelLabel="stay"
    onConfirm={saveAndDone}
    onSecondary={discardAndDone}
    onCancel={() => modal = 'none'}
  />
{/if}
