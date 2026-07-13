<script lang="ts">
  import type { Session } from '../../core/domain/types'
  import { sessionRecords } from '../../core/records/records'
  import { hashFor } from '../../core/routing/route'
  import type { StorageContext } from '../data/storage-context'
  import { formatDateTime } from '../fly/fly-format'
  import LapTable from '../fly/LapTable.svelte'
  import RecordsSummary from '../shared/RecordsSummary.svelte'

  // Persisted-session review (product.md "Session view"): lap table with
  // highlights/strikethrough, header with course/date/note/records, note
  // editing. App keys this screen on sessionId.
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
  // Orphan sessions (courseId matching no course — an imported session whose
  // course never arrived, storage.md merge rules) render with the "unknown
  // course" placeholder; while courses are still loading, stay neutral.
  const courseLabel = $derived(
    course !== undefined ? course.name : coursesRepo.loaded ? 'Unknown course' : 'Session',
  )
  const records = $derived(session === null ? null : sessionRecords(session.laps))
  const noteDirty = $derived(session !== null && note !== session.note)

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
  <header>
    {#if course !== undefined}
      <a href={hashFor({ id: 'course', courseId: course.id })}>{course.name}</a>
    {:else}
      <a href={hashFor({ id: 'home' })}>Courses</a>
    {/if}
  </header>

  {#if !loadSettled}
    <p class="hint">Loading session…</p>
  {:else if session === null}
    <!-- not-found also covers a quarantined (corrupt, set-aside) file. -->
    <p class="notice-error">
      This session does not exist — it may have been removed, or its file was damaged and set
      aside.
    </p>
    <a href={hashFor({ id: 'home' })}>Back to courses</a>
  {:else}
    <h1>{courseLabel}</h1>
    <p class="meta">{formatDateTime(session.startedAt)}</p>

    <!-- Stacked on the phone; records/note beside the lap table on desktop
         (the review story — 48rem breakpoint, see App.svelte). -->
    <div class="review-columns">
      <div class="session-info">
        {#if records !== null}
          <RecordsSummary {records} lapCount={session.laps.length} />
        {/if}

        <label class="note">
          <span>Note</span>
          <textarea rows="2" placeholder="e.g. new props, windy day" bind:value={note}></textarea>
        </label>
        {#if noteDirty || savingNote}
          <div class="controls">
            <button
              class="primary"
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
      </div>

      <div class="session-laps">
        <LapTable laps={session.laps} />
      </div>
    </div>
  {/if}
</main>

<style>
  header {
    margin-bottom: 0.75rem;
    font-size: 0.9rem;
  }

  h1 {
    margin: 0;
    font-size: 1.5rem;
  }

  .meta {
    margin: 0.25rem 0 1rem;
    opacity: 0.75;
  }

  .note {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    margin: 0.9rem 0 0.5rem;
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

  .controls {
    display: flex;
    align-items: center;
    gap: 0.9rem;
    margin: 0.5rem 0 1rem;
  }

  button {
    background: #1d3a6e;
    color: #e8edf7;
    border: 1px solid #3b5fa3;
    border-radius: 0.375rem;
    padding: 0.45rem 1.2rem;
    font-size: 0.95rem;
    font-weight: 600;
    cursor: pointer;
  }

  button:hover:not(:disabled) {
    border-color: #7ea6ff;
  }

  button:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .hint {
    opacity: 0.75;
    font-size: 0.9rem;
  }

  @media (min-width: 48rem) {
    main {
      max-width: 64rem;
    }

    .review-columns {
      display: grid;
      grid-template-columns: minmax(18rem, 24rem) minmax(0, 44rem);
      gap: 2.5rem;
      align-items: start;
    }
  }
</style>
