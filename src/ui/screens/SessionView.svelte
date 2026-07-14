<script lang="ts">
  import type { Session } from '../../core/domain/types'
  import { sessionRecords } from '../../core/records/records'
  import { hashFor } from '../../core/routing/route'
  import type { StorageContext } from '../data/storage-context'
  import { formatDateTime } from '../fly/fly-format'
  import LapTable from '../fly/LapTable.svelte'
  import AppBar from '../shared/AppBar.svelte'
  import RecTiles from '../shared/RecTiles.svelte'

  // Persisted-session review (product.md "Session view", mockup screen 07):
  // header card with date/note/record tiles, mono lap table with the best-3
  // bracket, note editing. App keys this screen on sessionId.
  let { context, sessionId }: { context: StorageContext; sessionId: string } = $props()

  // svelte-ignore state_referenced_locally
  const sessionsRepo = context.sessionsRepo
  // svelte-ignore state_referenced_locally
  const coursesRepo = context.coursesRepo

  void coursesRepo.ensureLoaded()

  let session = $state<Session | null>(null)
  let loadSettled = $state(false)
  let note = $state('')
  let savingNote = $state(false)
  let noteError = $state<string | null>(null)

  // svelte-ignore state_referenced_locally
  void sessionsRepo.loadSession(sessionId).then((loaded) => {
    if (loaded !== undefined) {
      session = loaded
      note = loaded.note
    }
    loadSettled = true
  })

  const course = $derived(session === null ? undefined : coursesRepo.courseById(session.courseId))
  const records = $derived(session === null ? null : sessionRecords(session.laps))
  const noteDirty = $derived(session !== null && note !== session.note)
  const discardedLapNumbers = $derived(
    session === null
      ? []
      : session.laps.filter((lap) => lap.status === 'discarded').map((lap) => lap.n),
  )

  // Orphan sessions (courseId matching no course — an imported session whose
  // course never arrived, storage.md merge rules) render with the "unknown
  // course" placeholder; while courses are still loading, stay neutral.
  const appBarProps = $derived.by(() => {
    if (course !== undefined) {
      const courseHref = hashFor({ id: 'course', courseId: course.id })
      return { backHref: courseHref, subtitle: course.name, subtitleHref: courseHref }
    }
    if (session !== null && coursesRepo.loaded) {
      return { backHref: hashFor({ id: 'home' }), subtitle: 'Unknown course' }
    }
    return { backHref: hashFor({ id: 'home' }) }
  })

  async function saveNote(): Promise<void> {
    if (session === null || !noteDirty || savingNote) return
    savingNote = true
    noteError = null
    // $state.snapshot: `session` is a $state proxy, and the storage layer
    // structuredClones what it is given — proxies are not cloneable.
    const updated = { ...$state.snapshot(session), note }
    const ok = await sessionsRepo.saveSession(updated)
    if (ok) {
      session = updated
    } else {
      noteError = sessionsRepo.lastError?.message ?? 'save failed'
    }
    savingNote = false
  }
</script>

<main class="session-view">
  <AppBar title="Session" {...appBarProps} />

  {#if !loadSettled}
    <p class="hint">Loading session…</p>
  {:else if session === null}
    <!-- not-found also covers a quarantined (corrupt, set-aside) file. -->
    <p class="notice-error">
      This session does not exist — it may have been removed, or its file was damaged and set
      aside.
    </p>
    <p><a href={hashFor({ id: 'home' })}>Back to courses</a></p>
  {:else}
    <!-- Stacked on the phone; header card beside the lap table on desktop
         (the review story — 48rem breakpoint, see App.svelte). -->
    <div class="review-columns">
      <div class="card session-info">
        <div class="date mono">{formatDateTime(session.startedAt)}</div>

        <div class="note">
          <textarea
            rows="2"
            placeholder="e.g. new props, windy day"
            aria-label="Session note"
            bind:value={note}
          ></textarea>
        </div>
        {#if noteDirty || savingNote}
          <div class="controls">
            <button
              class="btn btn-primary"
              onclick={() => void saveNote()}
              disabled={savingNote || context.readOnly}
            >
              {savingNote ? 'Saving…' : 'Save note'}
            </button>
            {#if context.readOnly}
              <span class="hint">Read-only: another tab is active.</span>
            {/if}
          </div>
        {/if}
        {#if noteError !== null}
          <p class="notice-error">Could not save the note: {noteError}</p>
        {/if}

        {#if records !== null}
          <div class="recs-row">
            <RecTiles
              bestLapMs={records.bestLap?.durationMs}
              bestThreeMs={records.bestThreeConsecutive?.totalMs}
            />
          </div>
        {/if}
      </div>

      <div class="session-laps">
        <div class="card laps-card">
          <LapTable laps={session.laps} />
        </div>
        {#if discardedLapNumbers.length > 0}
          <p class="hint discard-note">
            Lap{discardedLapNumbers.length > 1 ? 's' : ''}
            {discardedLapNumbers.join(', ')} discarded — the best-3 window can't span
            {discardedLapNumbers.length > 1 ? 'them' : 'it'}.
          </p>
        {/if}
      </div>
    </div>

    <!-- Outside the columns, so it is the last thing on the page in both
         layouts and never lands beside the note's Save button. The
         confirmation is a screen of its own (plan 09 item 8) — this only
         navigates. -->
    <section class="danger">
      {#if context.readOnly}
        <button class="btn btn-danger-ghost" disabled>
          {@render deleteLabel()}
        </button>
      {:else}
        <a class="btn btn-danger-ghost" href={hashFor({ id: 'delete-session', sessionId })}>
          {@render deleteLabel()}
        </a>
      {/if}
    </section>
  {/if}
</main>

{#snippet deleteLabel()}
  <svg class="ic" viewBox="0 0 24 24">
    <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
  </svg>
  Delete session
{/snippet}

<style>
  .review-columns {
    margin-top: 0.9rem;
  }

  .date {
    font-size: 0.82rem;
    color: var(--c-dim);
  }

  /* Mockup .rev-head .note: italic signal-cyan. The mockup's quote glyphs are
     dropped — the note is an always-editable textarea, and flanking quotes
     detach from the text as it wraps or stays short. */
  .note {
    margin-top: 8px;
    font-size: 0.84rem;
    font-style: italic;
    color: var(--c-signal);
  }

  .note textarea {
    width: 100%;
    background: transparent;
    border: none;
    padding: 0;
    color: var(--c-signal);
    font-family: inherit;
    font-size: inherit;
    font-style: inherit;
    line-height: 1.4;
    resize: none;
  }

  .note textarea::placeholder {
    color: var(--c-dim2);
  }

  .controls {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-top: 0.7rem;
  }

  .notice-error {
    margin: 0.7rem 0 0;
  }

  main > .notice-error {
    margin-top: 0.9rem;
  }

  .recs-row {
    margin-top: 12px;
  }

  .session-laps {
    margin-top: 0.9rem;
  }

  .laps-card {
    padding: 6px 4px;
  }

  .discard-note {
    margin: 8px 4px 0;
    text-align: center;
    line-height: 1.45;
  }

  .danger {
    margin-top: 2rem;
    padding-top: 1.5rem;
    border-top: 1px solid var(--c-line);
  }

  .danger a {
    text-decoration: none;
  }

  @media (min-width: 48rem) {
    main {
      max-width: 64rem;
    }

    /* Matches the header column's width: a full 64rem danger button would
       shout louder than anything else on the page. */
    .danger {
      max-width: 24rem;
    }

    .review-columns {
      display: grid;
      grid-template-columns: minmax(18rem, 24rem) minmax(0, 44rem);
      gap: 2.5rem;
      align-items: start;
    }

    .session-laps {
      margin-top: 0;
    }
  }
</style>
