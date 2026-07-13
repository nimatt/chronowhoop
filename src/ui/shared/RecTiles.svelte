<script lang="ts">
  import { recTileValue } from './rec-format'

  // Mockup .recs/.rec pair: best lap (amber value) + best 3 consecutive
  // (ink value, .b3). Values are milliseconds; undefined renders as an em
  // dash. meta is the optional per-tile date line (course view's "Jul 11").
  let {
    bestLapMs,
    bestThreeMs,
    bestLapLabel = 'Best lap',
    bestThreeLabel = 'Best 3',
    bestLapMeta,
    bestThreeMeta,
  }: {
    bestLapMs?: number
    bestThreeMs?: number
    bestLapLabel?: string
    bestThreeLabel?: string
    bestLapMeta?: string
    bestThreeMeta?: string
  } = $props()
</script>

{#snippet tile(label: string, ms: number | undefined, meta: string | undefined, b3: boolean)}
  {@const value = recTileValue(ms)}
  <div class="rec" class:b3>
    <div class="k">{label}</div>
    <div class="v" class:none={value.unit === undefined}>
      {value.text}{#if value.unit !== undefined}<small>{value.unit}</small>{/if}
    </div>
    {#if meta !== undefined}
      <div class="meta">{meta}</div>
    {/if}
  </div>
{/snippet}

<div class="recs">
  {@render tile(bestLapLabel, bestLapMs, bestLapMeta, false)}
  {@render tile(bestThreeLabel, bestThreeMs, bestThreeMeta, true)}
</div>

<style>
  .recs {
    display: flex;
    gap: 10px;
  }

  .rec {
    flex: 1;
    background: var(--c-ground);
    border: 1px solid var(--c-line);
    border-radius: 11px;
    padding: 9px 11px;
  }

  .k {
    font-family: var(--font-mono);
    font-size: 0.58rem;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--c-dim2);
  }

  .v {
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    font-size: 1.34rem;
    color: var(--c-record);
    font-weight: 600;
    margin-top: 3px;
    line-height: 1;
  }

  .v small {
    font-size: 0.7rem;
    color: var(--c-dim);
    font-weight: 400;
    margin-left: 2px;
  }

  .rec.b3 .v {
    color: var(--c-ink);
  }

  .rec .v.none {
    color: var(--c-dim2);
  }

  .meta {
    font-family: var(--font-mono);
    font-size: 0.68rem;
    color: var(--c-dim2);
    margin-top: 6px;
  }
</style>
