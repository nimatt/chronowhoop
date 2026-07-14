<script lang="ts">
  import { hashFor } from '../../core/routing/route'
  import type { SessionSummary } from '../../core/storage/storage'
  import type { StorageContext } from '../data/storage-context'
  import AppBar from '../shared/AppBar.svelte'
  import { runExport, type ExportNotice } from '../shared/export-action'
  import {
    deleteBackupWarning,
    deleteCourseBody,
    deleteCourseConfirmLabel,
    deleteCourseFailureNotice,
    deleteCourseTitle,
    deleteExportNotice,
    type CourseBlastRadius,
    type CourseBlastRadiusOrUnknown,
  } from './delete-copy'

  // The course delete confirmation (plan 09 item 8, route #/course/<id>/delete).
  // An ordinary screen, not a modal: the app has no modal vocabulary (ADR 0007),
  // a screen gets Back-to-cancel for free, and the transition breaks the
  // reflex-tap rhythm that makes an in-place confirm unsafe under a cold thumb.
  let { context, courseId }: { context: StorageContext; courseId: string } = $props()

  // svelte-ignore state_referenced_locally
  const coursesRepo = context.coursesRepo
  // svelte-ignore state_referenced_locally
  const sessionsRepo = context.sessionsRepo

  void coursesRepo.ensureLoaded()

  // THE LOAD GATE (plan 09 item 8 [R2]) — the reason this screen has states at
  // all. refresh(), never ensureLoaded(): flights persist sessions behind the
  // repo's back (CourseView refreshes on every mount for the same reason), so a
  // cached list can under-count what is about to be destroyed. And an UNLOADED
  // repo has an empty summary list with a NULL lastError, so "no error" is not
  // "no sessions": deriving counts before this settles renders "Nothing has been
  // flown on this course yet", suppresses the not-backed-up warning, and then
  // destroys twelve sessions.
  let sessionsSettled = $state(false)
  void sessionsRepo.refresh().then(() => {
    sessionsSettled = true
  })

  const countsLoaded = $derived(sessionsSettled && sessionsRepo.lastError === null)
  const liveDoomedSessions = $derived(countsLoaded ? sessionsRepo.sessionsForCourse(courseId) : [])

  // null — never { sessionCount: 0 } — until the repo has actually answered: a
  // count we could not obtain is not a count of zero (delete-copy.ts).
  // lapCount is ALL laps, valid and discarded: a discarded lap keeps every byte
  // and the cascade destroys it like any other, so counting only the valid ones
  // would undersell the blast radius.
  const liveBlastRadius = $derived<CourseBlastRadiusOrUnknown>(
    countsLoaded
      ? {
          sessionCount: liveDoomedSessions.length,
          lapCount: liveDoomedSessions.reduce((total, summary) => total + summary.lapCount, 0),
        }
      : null,
  )

  const liveCourse = $derived(coursesRepo.courseById(courseId))

  // Frozen at confirm time — EVERYTHING the screen renders or acts on, not just
  // the headline. Both the course and its sessions leave the repo snapshots the
  // instant the cascade commits, while location.replace() is still a later task,
  // so without this the screen rewrites itself mid-delete (title, body, button
  // and backup warning all shedding the counts it just promised) and the failure
  // notice has no count left to contradict.
  //
  // The doomed list is frozen for a second reason: on a FAILED cascade the screen
  // holds for a retry, and the context then refreshes SessionsRepo — a refresh
  // that can itself fail (the store just refused a write). Live-gating the retry
  // on countsLoaded would then disable the Delete button under the very notice
  // telling the user to try again, which is the recovery path the whole intent
  // marker exists to serve.
  let confirmed = $state<{
    courseName: string
    blastRadius: CourseBlastRadius
    doomedSessions: SessionSummary[]
  } | null>(null)
  let deleting = $state(false)
  let failure = $state<string | null>(null)

  const courseName = $derived(confirmed?.courseName ?? liveCourse?.name ?? '')
  const blastRadius = $derived<CourseBlastRadiusOrUnknown>(
    confirmed?.blastRadius ?? liveBlastRadius,
  )
  const doomedSessions = $derived(confirmed?.doomedSessions ?? liveDoomedSessions)

  // THE FLASH GUARD (plan 09 item 8 [R2]): from the moment the user confirms,
  // this screen stops asking the repo whether the course exists. `liveCourse` is
  // derived off the reactive snapshot, and deleteCourse's onChange lands before
  // location.replace() runs — so an ungated not-found branch flashes "This course
  // does not exist" at the person who just deleted it.
  const notFound = $derived(coursesRepo.loaded && liveCourse === undefined && confirmed === null)

  const backupWarning = $derived(
    blastRadius === null
      ? null
      : deleteBackupWarning({
          sessionSummaries: doomedSessions,
          lastExportAt: coursesRepo.settings.lastExportAt,
        }),
  )

  const homeHash = hashFor({ id: 'home' })
  const courseHash = $derived(hashFor({ id: 'course', courseId }))

  let exporting = $state(false)
  let exportNotice = $state<ExportNotice | null>(null)

  // Before the confirm, the live repo state; after it, the frozen snapshot —
  // never a mix. A retry must not depend on a repo that answered once and has
  // since gone dark.
  const canDelete = $derived(confirmed !== null || (countsLoaded && liveCourse !== undefined))

  // The escape hatch, never a gate: it does not auto-continue into the delete,
  // and a failed export does not disable the Delete button. The user asked to
  // destroy this course; a backup they could not take is their call to make.
  async function exportBackup(): Promise<void> {
    if (exporting) return
    exporting = true
    exportNotice = null
    exportNotice = deleteExportNotice(await runExport(context), 'course')
    exporting = false
  }

  async function confirmDelete(): Promise<void> {
    // `exporting` is a hard gate, and the one place the two buttons are not
    // merely symmetric: a delete landing inside runExport's session scan tears
    // the very backup it is taking, and the success path unmounts this screen
    // before the export notice — success OR failure — can ever be read. The
    // escape hatch is worthless if the user can destroy the data mid-escape.
    if (deleting || exporting || context.readOnly) return
    if (confirmed === null) {
      if (liveBlastRadius === null || liveCourse === undefined) return
      confirmed = {
        courseName: liveCourse.name,
        blastRadius: liveBlastRadius,
        doomedSessions: liveDoomedSessions,
      }
    }
    const sessionsDoomed = confirmed.blastRadius.sessionCount
    deleting = true
    failure = null

    if (await coursesRepo.deleteCourse(courseId)) {
      // replace(), not `location.hash =`: a push would leave this confirm route
      // — for a course that no longer exists — one Back tap away. Nothing is said
      // on success: the course being gone from the screen we land on IS the
      // confirmation, and there is no cross-route notice channel.
      location.replace(homeHash)
      return
    }

    // The screen HOLDS on failure — retry is safe, both storage methods are
    // idempotent. The cascade removed session files behind SessionsRepo's back
    // and the context's deleteCourse already refreshed it on both outcomes
    // (storage-context.svelte.ts), so what still lists is current: the promise
    // minus the survivors is what actually went.
    //
    // But only if that refresh SUCCEEDED. SessionsRepo.refresh() keeps its stale
    // list on failure and merely sets lastError — and this refresh follows a
    // store that just refused a write, so it is exactly the one likely to fail.
    // Trusting the stale list then counts every doomed session as a survivor,
    // computes "deleted 0", and drops the resume sentence precisely when the
    // intent marker is on disk and the sessions really are gone. Unknown, not
    // zero (delete-copy.ts).
    const survivors =
      sessionsRepo.lastError === null ? sessionsRepo.sessionsForCourse(courseId).length : null
    const reason = coursesRepo.lastError?.message
    failure = deleteCourseFailureNotice({
      sessionsDeleted: survivors === null ? null : sessionsDoomed - survivors,
      sessionsDoomed,
      // The store's own words: "quota exceeded" is the difference between a
      // retry worth making and one that cannot possibly work.
      ...(reason === undefined ? {} : { reason }),
    })
    deleting = false
  }
</script>

<main class="delete-course">
  <AppBar title="Delete course" backHref={courseHash} />

  <!-- THE LOAD GATE IS INSIDE THE FREEZE (`confirmed === null`), like every
       other branch here. CoursesRepo.reload() INVALIDATES on failure (repos.ts),
       and deleteCourse's failure arm reloads a store that just refused a write —
       so `loaded` can go false while this screen is holding open for a retry. An
       ungated gate would then swap the whole confirm body, failure notice and
       Delete button included, for a bare storage error: the user is never told
       the deletion resumes on next launch, and the retry the freeze exists to
       serve is gone with it (ensureLoaded fires once, so it never comes back). -->
  {#if !coursesRepo.loaded && confirmed === null}
    {#if coursesRepo.lastError !== null}
      <p class="notice-error">Storage error: {coursesRepo.lastError.message}</p>
    {:else}
      <p class="loading">Loading course…</p>
    {/if}
  {:else if notFound}
    <p class="notice-error">This course does not exist — it may have been deleted.</p>
    <p><a href={homeHash}>Back to courses</a></p>
  {:else}
    <h2>{deleteCourseTitle(courseName)}</h2>
    <p class="body">{deleteCourseBody(blastRadius)}</p>

    <!-- Pre-confirm only: after the confirm the counts are frozen, and the
         refresh that follows a failed cascade fails for the same reason the
         cascade did. Ungated, it stacks "could not be counted" on top of the
         failure notice that already says so, in the store's own words. -->
    {#if confirmed === null && !countsLoaded && sessionsRepo.lastError !== null}
      <p class="notice-error">
        The sessions on this course could not be counted: {sessionsRepo.lastError.message}
      </p>
    {/if}

    {#if backupWarning !== null}
      <p class="notice-warning">{backupWarning}</p>
      <button
        class="btn btn-ghost"
        disabled={exporting || deleting}
        onclick={() => void exportBackup()}
      >
        {exporting ? 'Exporting…' : 'Export backup first'}
      </button>
    {/if}

    {#if exportNotice !== null}
      <p class={exportNotice.ok ? 'action-ok' : 'notice-error'} role="status">
        {exportNotice.text}
      </p>
    {/if}

    {#if failure !== null}
      <p class="notice-error" role="alert">{failure}</p>
    {/if}

    {#if context.readOnly}
      <p class="notice-warning">Read-only: another tab is active — nothing can be deleted here.</p>
    {/if}

    <div class="cta stack">
      <button class="btn btn-ghost" disabled={deleting} onclick={() => (location.hash = courseHash)}>
        Cancel
      </button>
      <button
        class="btn btn-danger"
        disabled={context.readOnly || !canDelete || deleting || exporting}
        onclick={() => void confirmDelete()}
      >
        {deleting ? 'Deleting…' : deleteCourseConfirmLabel(blastRadius)}
      </button>
    </div>
  {/if}
</main>

<style>
  main {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  h2 {
    margin: 10px 0 0;
    font-size: 1.15rem;
    letter-spacing: -0.01em;
  }

  .body {
    margin: 0;
    color: var(--c-dim);
    line-height: 1.5;
  }

  .notice-error,
  .notice-warning,
  .action-ok,
  .loading {
    margin: 0;
  }

  .action-ok {
    font-size: 0.85rem;
    color: var(--c-signal);
    overflow-wrap: anywhere;
  }

  .loading {
    color: var(--c-dim);
  }

  /* Cancel above Delete: the safe choice sits under the reading thumb, and the
     destructive one is the deliberate reach. */
  .cta {
    margin-top: 0.75rem;
  }
</style>
