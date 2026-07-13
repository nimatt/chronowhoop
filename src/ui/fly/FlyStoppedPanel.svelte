<script lang="ts">
  import { sessionRecords } from '../../core/records/records'
  import { hashFor } from '../../core/routing/route'
  import { shouldNudgeBackup } from '../../core/storage/backup-nudge'
  import type { StorageContext } from '../data/storage-context'
  import AppBar from '../shared/AppBar.svelte'
  import RecTiles from '../shared/RecTiles.svelte'
  import { exportOutcomeNotice, runExport, type ExportNotice } from '../shared/export-action'
  import { formatDateTime } from './fly-format'
  import type { FlySession } from './fly-session'
  import LapTable from './LapTable.svelte'

  let { session, context }: { session: FlySession; context: StorageContext } = $props()

  // Backup nudge (plan 07 item 3): after a stopped session, gently prompt for
  // an export when unexported data exists and the last export is not recent
  // (shouldNudgeBackup). The summaries are refreshed at mount because flights
  // persist behind SessionsRepo's back (the invalidation rule) — the session
  // file exists from arm time, so the just-flown session is included. The
  // clock is captured once at mount; a successful export flows back through
  // settings.lastExportAt (reactive), retracting the nudge.
  const nudgeNow = Date.now()
  let summariesRefreshed = $state(false)
  // svelte-ignore state_referenced_locally
  void context.coursesRepo.ensureLoaded()
  // svelte-ignore state_referenced_locally
  void context.sessionsRepo.refresh().then(() => {
    summariesRefreshed = true
  })
  const showNudge = $derived(
    summariesRefreshed &&
      context.coursesRepo.loaded &&
      shouldNudgeBackup({
        sessionSummaries: context.sessionsRepo.summaries,
        ...(context.coursesRepo.settings.lastExportAt !== undefined
          ? { lastExportAt: context.coursesRepo.settings.lastExportAt }
          : {}),
        now: nudgeNow,
      }),
  )

  let exporting = $state(false)
  let exportNotice = $state<ExportNotice | null>(null)

  async function exportNow(): Promise<void> {
    if (exporting) return
    exporting = true
    exportNotice = null
    exportNotice = exportOutcomeNotice(await runExport(context))
    exporting = false
  }

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

<AppBar
  title="Session over"
  subtitle={session.course.name}
  backHref={hashFor({ id: 'course', courseId: session.course.id })}
/>

{#if session.stopCause === 'camera-lost'}
  <p class="notice-error" role="alert">
    The camera stopped working, so the session was stopped automatically. Completed laps are kept
    below.
    {#if session.captureError !== null}<br /><span class="detail">{session.captureError}</span>{/if}
  </p>
{/if}

{#if session.interruptionNotice}
  <div class="banner notice-warning" role="alert">
    <span>Detection was interrupted — laps during the gap were not detected.</span>
    <button onclick={() => session.dismissInterruption()}>Dismiss</button>
  </div>
{/if}

<header class="rev-head card">
  <div class="dateline mono">
    {#if session.sessionStartedAt !== null}{formatDateTime(session.sessionStartedAt)} · {/if}{laps.length}
    {laps.length === 1 ? 'lap' : 'laps'}
  </div>
  {#if saveState.kind === 'saved'}
    <p class="save-status saved">Session saved.</p>
  {:else if saveState.kind === 'saving'}
    <p class="save-status pending">Saving session…</p>
  {:else}
    <p class="save-status unsaved notice-warning" role="alert">
      Some laps may not be saved ({saveState.detail}).
      {#if persist.savedLapCount !== undefined && persist.savedLapCount > 0}
        Saved through lap {persist.savedLapCount}.
      {/if}
    </p>
  {/if}
  <label class="note">
    <span class="label">Session note</span>
    <textarea
      rows="2"
      placeholder="e.g. new props, windy day"
      value={session.note}
      oninput={onNoteInput}
    ></textarea>
  </label>
  <div class="rev-recs">
    <RecTiles
      bestLapMs={records.bestLap?.durationMs}
      bestThreeMs={records.bestThreeConsecutive?.totalMs}
    />
  </div>
</header>

{#if showNudge}
  <div class="backup-nudge" role="status">
    <span>Some sessions aren’t backed up yet — export your data to keep them safe.</span>
    <button onclick={() => void exportNow()} disabled={exporting}>
      {exporting ? 'Exporting…' : 'Export now'}
    </button>
  </div>
{/if}
{#if exportNotice !== null}
  <p class={exportNotice.ok ? 'export-ok' : 'notice-error'} role="status">{exportNotice.text}</p>
{/if}

<LapTable {laps} />

<div class="actions">
  <button class="btn btn-primary" onclick={() => session.newSession()}>New session</button>
</div>

<style>
  .banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    margin: 0.75rem 0;
  }

  .detail {
    font-size: 0.8rem;
    opacity: 0.85;
  }

  .rev-head {
    margin: 0.75rem 0;
  }

  .dateline {
    font-size: 0.82rem;
    color: var(--c-dim);
  }

  .save-status {
    margin: 0.5rem 0;
    font-size: 0.9rem;
  }

  .save-status.saved {
    color: var(--c-signal);
  }

  .save-status.pending {
    color: var(--c-dim);
  }

  .save-status.unsaved {
    margin: 0.5rem 0;
  }

  /* The mockup's italic cyan session note, kept editable in place. */
  .note {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    margin: 0.75rem 0;
  }

  .note textarea {
    background: var(--c-ground);
    color: var(--c-signal);
    font-style: italic;
    border: 1px solid var(--c-line);
    border-radius: 12px;
    padding: 11px 13px;
    font-size: 0.9rem;
    font-family: inherit;
    resize: none;
  }

  .note textarea::placeholder {
    color: var(--c-dim2);
    font-style: italic;
  }

  .rev-recs {
    margin-top: 0.5rem;
  }

  .backup-nudge {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    margin: 0.75rem 0;
    padding: 0.6rem 0.8rem;
    border-radius: 12px;
    background: var(--c-panel);
    border: 1px solid var(--c-line);
    font-size: 0.95rem;
  }

  .backup-nudge button {
    flex-shrink: 0;
  }

  .export-ok {
    margin: 0.5rem 0;
    font-size: 0.9rem;
    color: var(--c-signal);
    overflow-wrap: anywhere;
  }

  .actions {
    margin-top: 1.25rem;
  }
</style>
