<script lang="ts">
  import type { Snippet } from 'svelte'

  // Mockup .meter card around the energy-bars canvas. The canvas itself draws
  // bars + trigger line (energy-bars.ts, the per-frame channel); this frame
  // adds the card, the mono header, and a CSS "trigger" label overlay aligned
  // to the same triggerLevel the canvas uses. The overlay assumes the child
  // canvas fills the frame's width without extra vertical margins — give the
  // canvas display:block and no margin so bottom-percent lines up.
  let {
    stripCount,
    label,
    status,
    triggerLevel,
    children,
  }: {
    stripCount?: number
    label?: string
    status?: Snippet
    triggerLevel?: number
    children: Snippet
  } = $props()

  const headLabel = $derived(
    label ?? (stripCount === undefined ? 'Motion energy' : `Motion energy · ${stripCount} strips`),
  )
  const triggerPct = $derived(
    triggerLevel === undefined ? undefined : Math.min(1, Math.max(0, triggerLevel)) * 100,
  )
</script>

<div class="meter">
  <div class="mhead">
    <span class="label">{headLabel}</span>
    {#if status}<span class="status">{@render status()}</span>{/if}
  </div>
  <div class="viz">
    {@render children()}
    {#if triggerPct !== undefined}
      <span class="triglabel" style="bottom: {triggerPct}%">trigger</span>
    {/if}
  </div>
</div>

<style>
  .meter {
    background: var(--c-panel);
    border: 1px solid var(--c-line);
    border-radius: 14px;
    padding: 12px;
  }

  .mhead {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 10px;
  }

  .status {
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    font-size: 0.66rem;
    color: var(--c-signal);
  }

  .viz {
    position: relative;
  }

  .triglabel {
    position: absolute;
    right: 2px;
    margin-bottom: 2px;
    font-family: var(--font-mono);
    font-size: 0.56rem;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--c-record);
    pointer-events: none;
  }
</style>
