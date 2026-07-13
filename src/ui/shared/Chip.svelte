<script lang="ts">
  import type { Snippet } from 'svelte'

  // Mockup .chip: mono pill. Plain = neutral status, ok = cyan (live/held),
  // warm = amber (records). `class` passes positioning classes through
  // (e.g. the preview's dirchip) — mark those :global in the consumer.
  let {
    variant,
    icon,
    children,
    class: extraClass = '',
  }: {
    variant?: 'ok' | 'warm'
    icon?: Snippet
    children: Snippet
    class?: string
  } = $props()
</script>

<span class={['chip', variant, extraClass]}>
  {#if icon}{@render icon()}{/if}
  {@render children()}
</span>

<style>
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-mono);
    font-size: 0.68rem;
    letter-spacing: 0.04em;
    padding: 5px 9px;
    border-radius: 999px;
    border: 1px solid var(--c-line);
    color: var(--c-dim);
    background: var(--c-panel);
  }

  .chip.ok {
    color: var(--c-signal);
    border-color: var(--c-signal-dim);
    background: rgba(51, 222, 207, 0.07);
  }

  .chip.warm {
    color: var(--c-record);
    border-color: var(--c-record-dim);
    background: rgba(255, 184, 77, 0.07);
  }
</style>
