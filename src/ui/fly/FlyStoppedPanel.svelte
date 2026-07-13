<script lang="ts">
  import { sessionRecords } from '../../core/records/records'
  import { formatLapSeconds } from './fly-format'
  import type { FlySession } from './fly-session'
  import LapTable from './LapTable.svelte'

  let { session }: { session: FlySession } = $props()

  const laps = $derived(session.laps)
  const records = $derived(sessionRecords(laps))
</script>

{#if session.stopCause === 'camera-lost'}
  <p class="error" role="alert">
    The camera stopped working, so the session was stopped automatically. Completed laps are kept
    below.
    {#if session.captureError !== null}<br /><span class="detail">{session.captureError}</span>{/if}
  </p>
{/if}

{#if session.interruptionNotice}
  <div class="banner" role="alert">
    <span>Detection was interrupted — laps during the gap were not detected.</span>
    <button onclick={() => session.dismissInterruption()}>Dismiss</button>
  </div>
{/if}

<header class="summary">
  <h2>Session over</h2>
  <dl class="records">
    <div>
      <dt>best lap</dt>
      <dd>{records.bestLap === undefined ? '—' : formatLapSeconds(records.bestLap.durationMs)}</dd>
    </div>
    <div>
      <dt>best 3 consecutive</dt>
      <dd>
        {records.bestThreeConsecutive === undefined
          ? '—'
          : formatLapSeconds(records.bestThreeConsecutive.totalMs)}
      </dd>
    </div>
    <div>
      <dt>laps</dt>
      <dd>{laps.length}</dd>
    </div>
  </dl>
</header>

<LapTable {laps} />

<p class="hint">
  Nothing is saved yet — this session evaporates on reload (storage arrives in Phase 6).
</p>

<div class="controls actions">
  <button class="primary" onclick={() => session.newSession()}>New session</button>
</div>

<style>
  .banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    margin: 0.75rem 0;
    padding: 0.6rem 0.8rem;
    border-radius: 0.375rem;
    background: #4a3413;
    border: 1px solid #8a6420;
    color: #ffd27e;
    font-size: 0.95rem;
  }

  .detail {
    font-size: 0.8rem;
    opacity: 0.85;
  }

  .summary h2 {
    margin: 0.5rem 0;
    font-size: 1.3rem;
  }

  .records {
    display: grid;
    grid-template-columns: repeat(3, auto);
    justify-content: start;
    gap: 1.5rem;
    margin: 0.75rem 0 1rem;
  }

  .records dt {
    opacity: 0.7;
    font-size: 0.85rem;
  }

  .records dd {
    margin: 0;
    font-size: 1.6rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .actions {
    margin-top: 1.25rem;
  }

  .actions button {
    padding: 0.7rem 1.6rem;
    font-size: 1.05rem;
  }
</style>
