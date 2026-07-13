<script lang="ts">
  import type { Records } from '../../core/records/records'
  import { formatLapSeconds } from '../fly/fly-format'

  // Shared best-lap / best-3-consecutive readout, used by SessionView (with
  // lapCount) and CourseView (all-time). FlyStoppedPanel renders the same
  // numbers with its own markup today and can adopt this later.
  let { records, lapCount }: { records: Records; lapCount?: number } = $props()
</script>

<dl class="records">
  <div>
    <dt>best lap</dt>
    <dd>
      {records.bestLap === undefined ? '—' : formatLapSeconds(records.bestLap.durationMs)}
    </dd>
  </div>
  <div>
    <dt>best 3 consecutive</dt>
    <dd>
      {records.bestThreeConsecutive === undefined
        ? '—'
        : formatLapSeconds(records.bestThreeConsecutive.totalMs)}
    </dd>
  </div>
  {#if lapCount !== undefined}
    <div>
      <dt>laps</dt>
      <dd>{lapCount}</dd>
    </div>
  {/if}
</dl>

<style>
  .records {
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: max-content;
    gap: 1.5rem;
    margin: 0.5rem 0 1rem;
  }

  dt {
    opacity: 0.7;
    font-size: 0.85rem;
  }

  dd {
    margin: 0;
    font-size: 1.6rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
</style>
