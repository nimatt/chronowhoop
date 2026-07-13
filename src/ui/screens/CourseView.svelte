<script lang="ts">
  import type { IsoDateString, Lap, Session } from '../../core/domain/types'
  import { bestLap, courseRecords, type Records } from '../../core/records/records'
  import { hashFor } from '../../core/routing/route'
  import type { StorageContext } from '../data/storage-context'
  import { formatLapSeconds } from '../fly/fly-format'
  import AppBar from '../shared/AppBar.svelte'
  import RecTiles from '../shared/RecTiles.svelte'
  import { courseSubtitle, formatShortDate, formatShortDateTime } from './course-format'

  let { context, courseId }: { context: StorageContext; courseId: string } = $props()

  // svelte-ignore state_referenced_locally
  const repo = context.coursesRepo
  // svelte-ignore state_referenced_locally
  const sessionsRepo = context.sessionsRepo

  void repo.ensureLoaded()

  const course = $derived(repo.courseById(courseId))

  interface SessionListItem {
    id: string
    startedAt: IsoDateString
    validLapCount: number
    discardedCount: number
    best: Lap | undefined
    note: string
  }

  // All-time records need lap bodies, so every session of the course is
  // loaded in full — the v1 full-scan storage.md documents (no session
  // index; data volumes are tiny) — and the session list renders from those
  // same bodies. Sessions are written behind the repo's back during a flight
  // (the persister goes straight to storage), so this view refresh()es on
  // every mount (App keys it on courseId) instead of trusting a cached list.
  // Unreadable (e.g. quarantined) sessions are skipped and reported locally.
  let allTime = $state<Records | null>(null)
  let sessionItems = $state<SessionListItem[] | null>(null)
  let unreadableCount = $state(0)
  void sessionsRepo.refresh().then(async () => {
    const sessions: Session[] = []
    let skipped = 0
    for (const summary of sessionsRepo.sessionsForCourse(courseId)) {
      const session = await sessionsRepo.loadSession(summary.id)
      if (session === undefined) {
        skipped += 1
        continue
      }
      sessions.push(session)
    }
    allTime = courseRecords(sessions)
    // Newest first, inherited from the summaries (the listSessions contract).
    sessionItems = sessions.map((session) => {
      const validLapCount = session.laps.filter((lap) => lap.status === 'valid').length
      return {
        id: session.id,
        startedAt: session.startedAt,
        validLapCount,
        discardedCount: session.laps.length - validLapCount,
        best: bestLap(session.laps),
        note: session.note.trim(),
      }
    })
    unreadableCount = skipped
  })

  function noteSnippet(note: string): string {
    return note.length > 64 ? `${note.slice(0, 63)}…` : note
  }
</script>

<main class="course-view">
  {#if repo.lastError !== null}
    <p class="notice-error">Storage error: {repo.lastError.message}</p>
  {/if}

  {#if !repo.loaded}
    <AppBar title="Course" backHref={hashFor({ id: 'home' })} />
    <p class="loading">Loading course…</p>
  {:else if course === undefined}
    <AppBar title="Course" backHref={hashFor({ id: 'home' })} />
    <p class="notice-error">This course does not exist.</p>
    <p><a href={hashFor({ id: 'home' })}>Back to courses</a></p>
  {:else}
    <AppBar
      title={course.name}
      subtitle={courseSubtitle(course)}
      backHref={hashFor({ id: 'home' })}
    >
      {#snippet actions()}
        <a class="edit" href={hashFor({ id: 'edit-course', courseId: course.id })}>Edit</a>
      {/snippet}
    </AppBar>

    <!-- Stacked on the phone; side-by-side columns on desktop (the review
         story: records at a glance next to the session list). -->
    <div class="review-columns">
      <div class="records-col">
        <section class="card records-card">
          <div class="label">All-time records</div>
          {#if allTime === null}
            <p class="loading">Loading sessions…</p>
          {:else}
            <RecTiles
              bestLapMs={allTime.bestLap?.durationMs}
              bestThreeMs={allTime.bestThreeConsecutive?.totalMs}
              bestThreeLabel="Best 3 consecutive"
              bestLapMeta={allTime.bestLap === undefined
                ? undefined
                : formatShortDate(allTime.bestLap.completedAt)}
              bestThreeMeta={allTime.bestThreeConsecutive === undefined
                ? undefined
                : formatShortDate(allTime.bestThreeConsecutive.laps[2].completedAt)}
            />
          {/if}
        </section>

        <a class="btn btn-primary start" href={hashFor({ id: 'fly', courseId: course.id })}>
          <svg class="ic play" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
          Start session
        </a>
      </div>

      <section class="sessions">
        <div class="label">Sessions</div>
        {#if sessionsRepo.lastError !== null}
          <p class="notice-error">Storage error: {sessionsRepo.lastError.message}</p>
        {/if}
        {#if unreadableCount > 0}
          <p class="notice-warning">
            {unreadableCount} session{unreadableCount === 1 ? '' : 's'} could not be read and
            {unreadableCount === 1 ? 'is' : 'are'} not shown.
          </p>
        {/if}
        {#if sessionItems === null}
          <p class="loading">Loading sessions…</p>
        {:else if sessionItems.length === 0}
          <p class="loading">No sessions yet — start a session to time your first laps here.</p>
        {:else}
          <ul class="list">
            {#each sessionItems as item (item.id)}
              <li>
                <a class="card session-card" href={hashFor({ id: 'session', sessionId: item.id })}>
                  <div class="row">
                    <span class="mono when">{formatShortDateTime(item.startedAt)}</span>
                    {#if item.best !== undefined}
                      <span class="mono best">{formatLapSeconds(item.best.durationMs)} s</span>
                    {/if}
                  </div>
                  <div class="meta">
                    {item.validLapCount} lap{item.validLapCount === 1 ? '' : 's'}
                    {#if item.discardedCount > 0}
                      ({item.discardedCount} discarded)
                    {/if}
                    {#if item.note !== ''}
                      · <span class="note">{noteSnippet(item.note)}</span>
                    {/if}
                  </div>
                </a>
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    </div>
  {/if}
</main>

<style>
  main {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .edit {
    align-self: center;
    font-family: var(--font-mono);
    font-size: 0.7rem;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--c-dim);
    text-decoration: none;
    padding: 8px 10px;
    border-radius: 10px;
    border: 1px solid var(--c-line);
    background: var(--c-panel);
  }

  .edit:hover {
    color: var(--c-ink);
    border-color: var(--c-signal-dim);
  }

  .review-columns,
  .records-col {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .records-card {
    padding: 16px;
  }

  .records-card .label {
    margin-bottom: 12px;
  }

  a.start {
    text-decoration: none;
  }

  .play {
    width: 20px;
    height: 20px;
  }

  .sessions {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .sessions ul {
    list-style: none;
    padding: 0;
    margin: 0;
  }

  a.session-card {
    display: block;
    padding: 13px;
    color: inherit;
    text-decoration: none;
  }

  a.session-card:hover {
    border-color: var(--c-signal-dim);
  }

  .row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 10px;
  }

  .when {
    font-size: 0.86rem;
  }

  .best {
    color: var(--c-record);
    font-size: 0.86rem;
  }

  .meta {
    font-family: var(--font-mono);
    font-size: 0.68rem;
    color: var(--c-dim);
    margin-top: 5px;
  }

  .note {
    color: var(--c-signal);
    font-style: italic;
  }

  .notice-error,
  .notice-warning {
    margin: 0;
  }

  .loading {
    margin: 0;
    color: var(--c-dim);
  }

  /* Desktop (48rem breakpoint, see App.svelte): records + start beside the
     session list — the import-a-phone-export-and-review story. */
  @media (min-width: 48rem) {
    main {
      max-width: 64rem;
    }

    .review-columns {
      display: grid;
      grid-template-columns: minmax(16rem, 22rem) minmax(0, 44rem);
      gap: 2.5rem;
      align-items: start;
    }
  }
</style>
