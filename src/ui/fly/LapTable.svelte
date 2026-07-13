<script lang="ts">
  import type { Lap } from '../../core/domain/types'
  import { sessionRecords } from '../../core/records/records'
  import { formatLapSeconds, formatTimeOfDay } from './fly-format'

  let { laps }: { laps: readonly Lap[] } = $props()

  // Records are computed from the lap list, never stored (ADR 0004). Lap
  // identity works because the records run over the same snapshot array the
  // rows render from.
  const records = $derived(sessionRecords(laps))
  const bestThreeLaps = $derived(new Set<Lap>(records.bestThreeConsecutive?.laps ?? []))
</script>

{#if laps.length === 0}
  <p class="hint">No laps completed.</p>
{:else}
  <div class="table-scroll">
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>duration (s)</th>
          <th>time of day</th>
          <th>status</th>
        </tr>
      </thead>
      <tbody>
        {#each laps as lap (lap.n)}
          <tr
            class:discarded={lap.status === 'discarded'}
            class:best={lap === records.bestLap}
            class:best-three={bestThreeLaps.has(lap)}
          >
            <td class="num">{lap.n}</td>
            <td class="num">
              {formatLapSeconds(lap.durationMs)}
              {#if lap === records.bestLap}<span class="tag">best</span>{/if}
            </td>
            <td class="num">{formatTimeOfDay(lap.completedAt)}</td>
            <td>{lap.status}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  {#if records.bestThreeConsecutive !== undefined}
    <p class="hint legend">
      <span class="swatch"></span> best three consecutive — {formatLapSeconds(
        records.bestThreeConsecutive.totalMs,
      )} s total
    </p>
  {/if}
{/if}

<style>
  .table-scroll {
    overflow-x: auto;
  }

  table {
    border-collapse: collapse;
    width: 100%;
    font-size: 1rem;
  }

  th,
  td {
    border: 1px solid #22304a;
    padding: 0.4rem 0.6rem;
    text-align: left;
  }

  th {
    background: #131e33;
    font-weight: 600;
    font-size: 0.85rem;
  }

  td.num {
    font-family: monospace;
    text-align: right;
    white-space: nowrap;
  }

  tr.best-three td {
    background: #16233c;
    border-left-color: #7ea6ff;
  }

  tr.best-three td:first-child {
    border-left: 3px solid #7ea6ff;
  }

  tr.best td {
    background: #14532d;
  }

  tr.discarded td {
    text-decoration: line-through;
    opacity: 0.55;
  }

  .tag {
    margin-left: 0.5rem;
    padding: 0.05rem 0.4rem;
    border-radius: 0.375rem;
    background: #86efac;
    color: #0b1220;
    font-size: 0.7rem;
    font-weight: 700;
    text-decoration: none;
  }

  .legend {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .swatch {
    display: inline-block;
    width: 0.9rem;
    height: 0.9rem;
    border-radius: 0.2rem;
    background: #16233c;
    border-left: 3px solid #7ea6ff;
  }
</style>
