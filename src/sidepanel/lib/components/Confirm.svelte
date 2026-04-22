<script lang="ts">
  import { onMount, tick } from 'svelte';

  interface Props {
    title?: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    secondaryLabel?: string;
    destructive?: boolean;
    onConfirm: () => void;
    onCancel: () => void;
    onSecondary?: () => void;
  }
  let {
    title,
    message,
    confirmLabel = 'confirm',
    cancelLabel = 'cancel',
    secondaryLabel,
    destructive = false,
    onConfirm,
    onCancel,
    onSecondary,
  }: Props = $props();

  let confirmBtn: HTMLButtonElement | undefined = $state();
  let cancelBtn: HTMLButtonElement | undefined = $state();

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    else if (e.key === 'Enter') { e.preventDefault(); onConfirm(); }
  }

  // Destructive dialogs default-focus cancel (macOS HIG convention) so a stray Enter
  // doesn't permanently drop data. Non-destructive dialogs default-focus confirm.
  onMount(async () => {
    const prev = document.activeElement as HTMLElement | null;
    await tick();
    if (destructive) cancelBtn?.focus();
    else confirmBtn?.focus();
    return () => { prev?.focus?.(); };
  });
</script>

<svelte:window onkeydown={onKey} />

<div class="modal-backdrop" onclick={onCancel} role="presentation">
  <div
    class="modal"
    role="dialog"
    aria-modal="true"
    onclick={(e) => e.stopPropagation()}
  >
    {#if title}<div class="modal-title">{title}</div>{/if}
    <div class="modal-msg">{message}</div>
    <div class="modal-actions">
      <button bind:this={cancelBtn} type="button" class="link gray" onclick={onCancel}>{cancelLabel}</button>
      {#if secondaryLabel && onSecondary}
        <span class="sep">·</span>
        <button type="button" class="link gray" onclick={onSecondary}>{secondaryLabel}</button>
      {/if}
      <span class="sep">·</span>
      <button
        bind:this={confirmBtn}
        type="button"
        class="link"
        class:destructive
        onclick={onConfirm}
      >{confirmLabel}</button>
    </div>
  </div>
</div>
