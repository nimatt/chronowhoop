<script lang="ts">
  import type { Lap } from '../../core/domain/types'
  import { sessionRecords } from '../../core/records/records'
  import { formatLapSeconds, formatTimeOfDay } from './fly-format'

  let { laps }: { laps: readonly Lap[] } = $props()

  // Records are computed from the lap list, never stored (ADR 0004). Lap
  // identity works because the records run over the same snapshot array the
  // rows render from.
  const records = $derived(sessionRecords(laps))
  const bestWindow = $derived(records.bestThreeConsecutive)
  const bestThreeLaps = $derived(new Set<Lap>(bestWindow?.laps ?? []))
  // The mockup puts the bracket label ABOVE the window by splitting the table
  // around it. The label is a plain element between two tables, never a
  // <tbody> row — tests count laps as `tbody tr`.
  const windowStart = $derived(
    bestWindow === undefined ? laps.length : laps.indexOf(bestWindow.laps[0]),
  )
</script>

{#snippet cols()}
  <colgroup>
    <col class="c-lap" />
    <col class="c-dur" />
    <col class="c-time" />
    <col class="c-status" />
  </colgroup>
{/snippet}

{#snippet lapRows(rows: readonly Lap[])}
  {#each rows as lap (lap.n)}
    <tr
      class:discarded={lap.status === 'discarded'}
      class:best={lap === records.bestLap}
      class:best-three={bestThreeLaps.has(lap)}
      class:b3band={bestThreeLaps.has(lap)}
      class:first={bestWindow !== undefined && lap === bestWindow.laps[0]}
    >
      <td><span class="lap-num"><span class="bar-i"></span>{lap.n}</span></td>
      <td>
        {formatLapSeconds(lap.durationMs)}
        {#if lap === records.bestLap}<span class="best-tag">best</span>{/if}
      </td>
      <td><span class="tod">{formatTimeOfDay(lap.completedAt)}</span></td>
      <td>
        {#if lap.status === 'discarded'}
          <span class="disc-tag">discarded</span>
        {:else}
          <span class="st-valid">{lap.status}</span>
        {/if}
      </td>
    </tr>
  {/each}
{/snippet}

{#if laps.length === 0}
  <p class="hint">No laps completed.</p>
{:else}
  <div class="table-scroll">
    <table class="table">
      {@render cols()}
      <thead>
        <tr>
          <th>Lap</th>
          <th>Duration</th>
          <th>Time</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {@render lapRows(laps.slice(0, windowStart))}
      </tbody>
    </table>
    {#if bestWindow !== undefined}
      <div class="b3label">
        <span>◄ Best 3 consecutive</span>
        <span>{formatLapSeconds(bestWindow.totalMs)} s</span>
      </div>
      <table class="table">
        {@render cols()}
        <tbody>
          {@render lapRows(laps.slice(windowStart))}
        </tbody>
      </table>
    {/if}
  </div>
  {#if bestWindow !== undefined}
    <p class="hint legend">
      best three consecutive — {formatLapSeconds(bestWindow.totalMs)} s total
    </p>
  {/if}
{/if}

<style>
  .table-scroll {
    overflow-x: auto;
  }

  /* Fixed layout with a shared colgroup keeps the columns of the two tables
     (split around the .b3label bracket) aligned. */
  table {
    table-layout: fixed;
  }

  .c-lap {
    width: 28%;
  }

  .c-dur {
    width: 26%;
  }

  .c-time {
    width: 26%;
  }

  .c-status {
    width: 20%;
  }

  .best-tag {
    font-family: var(--font-mono);
    font-size: 0.54rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--c-record);
    margin-left: 6px;
    display: inline-block;
    vertical-align: middle;
  }

  .st-valid {
    font-size: 0.7rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--c-dim2);
  }

  .legend {
    margin: 6px 4px 0;
    text-align: center;
  }
</style>
