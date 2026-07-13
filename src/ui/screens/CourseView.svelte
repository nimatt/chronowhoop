<script lang="ts">
  import type { IsoDateString, Lap, Session } from '../../core/domain/types'
  import { bestLap, courseRecords, type Records } from '../../core/records/records'
  import { hashFor } from '../../core/routing/route'
  import type { StorageContext } from '../data/storage-context'
  import { formatDateTime, formatLapSeconds } from '../fly/fly-format'
  import RecordsSummary from '../shared/RecordsSummary.svelte'
  import { directionLabel, formatMinLap } from './course-format'

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
      }
    })
    unreadableCount = skipped
  })
</script>

<main class="course-view">
  <header>
    <a href={hashFor({ id: 'home' })}>Courses</a>
  </header>

  {#if repo.lastError !== null}
    <p class="notice-error">Storage error: {repo.lastError.message}</p>
  {/if}

  {#if !repo.loaded}
    <p class="hint">Loading course…</p>
  {:else if course === undefined}
    <p class="notice-error">This course does not exist.</p>
    <a href={hashFor({ id: 'home' })}>Back to courses</a>
  {:else}
    <div class="title-row">
      <h1>{course.name}</h1>
      <a class="edit" href={hashFor({ id: 'edit-course', courseId: course.id })}>Edit</a>
    </div>
    <p class="meta">
      {directionLabel(course.direction)} · min lap {formatMinLap(course.minLapTimeMs)}
    </p>

    <a class="fly-button" href={hashFor({ id: 'fly', courseId: course.id })}>Fly</a>

    <section class="records-section">
      <h2>All-time records</h2>
      {#if allTime === null}
        <p class="hint">Loading sessions…</p>
      {:else}
        <RecordsSummary records={allTime} />
      {/if}
    </section>

    <section class="sessions">
      <h2>Sessions</h2>
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
        <p class="hint">Loading sessions…</p>
      {:else if sessionItems.length === 0}
        <p class="hint">No sessions yet — hit Fly to time your first laps here.</p>
      {:else}
        <ul>
          {#each sessionItems as item (item.id)}
            <li>
              <a href={hashFor({ id: 'session', sessionId: item.id })}>
                <span class="date">{formatDateTime(item.startedAt)}</span>
                <span class="counts">
                  {item.validLapCount} lap{item.validLapCount === 1 ? '' : 's'}
                  {#if item.discardedCount > 0}
                    ({item.discardedCount} discarded)
                  {/if}
                </span>
                <span class="best">
                  {#if item.best !== undefined}
                    best {formatLapSeconds(item.best.durationMs)}
                  {/if}
                </span>
              </a>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}
</main>

<style>
  header {
    margin-bottom: 0.75rem;
    font-size: 0.9rem;
  }

  .title-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.75rem;
  }

  h1 {
    margin: 0;
    font-size: 1.5rem;
  }

  .edit {
    font-size: 0.9rem;
  }

  .meta {
    margin: 0.25rem 0 1.25rem;
    opacity: 0.75;
  }

  .fly-button {
    display: inline-block;
    padding: 0.7rem 2.5rem;
    border-radius: 0.5rem;
    background: #1d3a6e;
    border: 1px solid #3b5fa3;
    color: #e8edf7;
    font-size: 1.2rem;
    font-weight: 600;
    text-decoration: none;
  }

  .fly-button:hover {
    border-color: #7ea6ff;
  }

  .records-section,
  .sessions {
    margin-top: 2rem;
  }

  .records-section h2,
  .sessions h2 {
    font-size: 1.1rem;
    margin-bottom: 0.4rem;
  }

  .sessions ul {
    list-style: none;
    padding: 0;
    margin: 0.5rem 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .sessions li a {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem 1rem;
    align-items: baseline;
    padding: 0.55rem 0.8rem;
    border-radius: 0.5rem;
    background: #16233c;
    border: 1px solid #2c3850;
    color: #e8edf7;
    text-decoration: none;
  }

  .sessions li a:hover {
    border-color: #7ea6ff;
  }

  .date {
    font-weight: 600;
  }

  .counts {
    opacity: 0.75;
    font-size: 0.9rem;
  }

  .best {
    margin-left: auto;
    font-variant-numeric: tabular-nums;
    font-size: 0.9rem;
  }

  .hint {
    opacity: 0.75;
  }
</style>
