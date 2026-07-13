<script lang="ts">
  import type { Snippet } from 'svelte'

  // Mockup .toast: cyan detection toast, absolutely positioned inside the
  // nearest position:relative ancestor (test mode overlays it on the preview).
  let {
    icon,
    top = '14px',
    children,
  }: {
    icon?: Snippet
    top?: string
    children: Snippet
  } = $props()
</script>

<div class="toast" role="status" style="top: {top}">
  {#if icon}{@render icon()}{/if}
  {@render children()}
</div>

<style>
  .toast {
    position: absolute;
    left: 18px;
    right: 18px;
    z-index: 6;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 13px 15px;
    border-radius: 13px;
    background: rgba(51, 222, 207, 0.14);
    border: 1px solid var(--c-signal);
    color: var(--c-signal);
    font-weight: 600;
    font-family: var(--font-mono);
    font-size: 0.9rem;
    letter-spacing: 0.01em;
    box-shadow: 0 12px 30px -10px rgba(51, 222, 207, 0.4);
  }
</style>
