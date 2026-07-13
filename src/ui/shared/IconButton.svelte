<script lang="ts">
  import type { Snippet } from 'svelte'

  // Mockup .iconbtn: 34px bordered icon button; children is the icon
  // (typically an <svg class="ic"> — .ic is global, see App.svelte).
  let {
    label,
    accent = false,
    disabled = false,
    onclick,
    children,
  }: {
    label: string
    accent?: boolean
    disabled?: boolean
    onclick?: (event: MouseEvent) => void
    children: Snippet
  } = $props()
</script>

<button class="iconbtn" class:accent aria-label={label} title={label} {disabled} {onclick}>
  {@render children()}
</button>

<style>
  .iconbtn {
    width: 34px;
    height: 34px;
    flex: none;
    border-radius: 10px;
    display: grid;
    place-items: center;
    background: var(--c-panel);
    border: 1px solid var(--c-line);
    color: var(--c-dim);
    cursor: pointer;
  }

  .iconbtn.accent {
    color: var(--c-signal);
    border-color: var(--c-signal-dim);
  }

  .iconbtn:disabled {
    opacity: 0.45;
    cursor: default;
  }
</style>
