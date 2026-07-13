<script lang="ts">
  import { sessionRecords } from '../../core/records/records'
  import { formatLapSeconds } from './fly-format'
  import type { FlySession } from './fly-session'
  import LapTable from './LapTable.svelte'

  let { session }: { session: FlySession } = $props()

  const laps = $derived(session.laps)
  const records = $derived(sessionRecords(laps))

  // The persister's unsaved-state, surfaced only here — after Stop, never
  // mid-flight (plan 06 item 5).
  const persist = $derived(session.persisterState)
  const saveState = $derived.by((): { kind: 'saving' | 'unsaved' | 'saved'; detail?: string } => {
    if (persist.pending) {
      return persist.lastError === undefined
        ? { kind: 'saving' }
        : { kind: 'unsaved', detail: `retrying: ${persist.lastError.message}` }
    }
    if (persist.lastError !== undefined) {
      return { kind: 'unsaved', detail: `${persist.lastError.kind}: ${persist.lastError.message}` }
    }
    return { kind: 'saved' }
  })

  // Persisted per input event, not on blur — Back navigation must not lose
  // the note. The persister coalesces, so per-keystroke calls cost one
  // structuredClone of a small session each, at most one write in flight.
  function onNoteInput(event: Event): void {
    session.setNote((event.currentTarget as HTMLTextAreaElement).value)
  }
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
  {#if saveState.kind === 'saved'}
    <p class="save-status saved">Session saved.</p>
  {:else if saveState.kind === 'saving'}
    <p class="save-status pending">Saving session…</p>
  {:else}
    <p class="save-status unsaved" role="alert">
      Some laps may not be saved ({saveState.detail}).
      {#if persist.savedLapCount !== undefined && persist.savedLapCount > 0}
        Saved through lap {persist.savedLapCount}.
      {/if}
    </p>
  {/if}
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

<label class="note">
  <span>Session note</span>
  <textarea
    rows="2"
    placeholder="e.g. new props, windy day"
    value={session.note}
    oninput={onNoteInput}
  ></textarea>
</label>

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

  .save-status {
    margin: 0.25rem 0;
    font-size: 0.9rem;
  }

  .save-status.saved {
    color: #86efac;
  }

  .save-status.pending {
    opacity: 0.75;
  }

  .save-status.unsaved {
    padding: 0.5rem 0.7rem;
    border-radius: 0.375rem;
    background: #3f2d15;
    border: 1px solid #7c5b2b;
    color: #ffcf8a;
    overflow-wrap: anywhere;
  }

  .note {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    margin: 0.9rem 0;
    font-size: 0.9rem;
  }

  .note textarea {
    background: #16233c;
    color: #e8edf7;
    border: 1px solid #2c3850;
    border-radius: 0.375rem;
    padding: 0.45rem 0.6rem;
    font-size: 0.95rem;
    font-family: inherit;
    resize: vertical;
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
