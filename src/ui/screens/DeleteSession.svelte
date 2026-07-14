<script lang="ts">
  import type { Session } from '../../core/domain/types'
  import { bestLap } from '../../core/records/records'
  import { hashFor } from '../../core/routing/route'
  import type { StorageContext } from '../data/storage-context'
  import AppBar from '../shared/AppBar.svelte'
  import { runExport, type ExportNotice } from '../shared/export-action'
  import {
    deleteBackupWarning,
    deleteExportNotice,
    deleteSessionBody,
    DELETE_BACKUP_UNKNOWN_WARNING,
    DELETE_SESSION_CONFIRM_LABEL,
    DELETE_SESSION_TITLE,
    type SessionBlastRadius,
  } from './delete-copy'

  // The session delete confirmation (plan 09 item 8, route #/session/<id>/delete).
  // An ordinary screen, not a modal — same reasoning as DeleteCourse.
  let { context, sessionId }: { context: StorageContext; sessionId: string } = $props()

  // svelte-ignore state_referenced_locally
  const sessionsRepo = context.sessionsRepo
  // svelte-ignore state_referenced_locally
  const coursesRepo = context.coursesRepo

  void coursesRepo.ensureLoaded()

  // The load gate, this screen's version: the body needs the best lap, which
  // SessionSummary does not carry, so the one session file is read. A one-shot
  // $state rather than a $derived off the repo — which is also why this screen
  // needs no flash guard: deleting the session cannot empty a snapshot it never
  // reads from.
  let session = $state<Session | null>(null)
  let loadSettled = $state(false)
  // svelte-ignore state_referenced_locally
  void sessionsRepo.loadSession(sessionId).then((loaded) => {
    session = loaded ?? null
    loadSettled = true
  })

  const course = $derived(session === null ? undefined : coursesRepo.courseById(session.courseId))

  // Deleting a session needs the SESSION and nothing else. courses.json carries
  // only two conveniences here — where to land, and lastExportAt — and neither
  // may hold the delete hostage: CoursesRepo.reload() sets `loaded` inside its
  // try, so one failed read (unsupported-version, an OPFS hiccup) leaves it false
  // forever, and gating on it would render the whole "Delete this session?" body
  // beside a permanently dead button with nothing to explain it.
  const canDelete = $derived(session !== null)

  // Where Back, Cancel and a successful delete land. Once the session is known so
  // is its courseId, so the arrow points at the course from the start instead of
  // pointing home and flipping when the courses repo settles. Home is for a TRUE
  // orphan only — a courseId matching no course in a repo that has ACTUALLY
  // ANSWERED. An unloaded repo is indistinguishable from an orphan and must not
  // be mistaken for one; if the course really is gone, #/course/<id> has its own
  // not-found branch to say so.
  const parentHash = $derived(
    session === null || (coursesRepo.loaded && course === undefined)
      ? hashFor({ id: 'home' })
      : hashFor({ id: 'course', courseId: session.courseId }),
  )

  // lapCount is ALL laps, valid and discarded; bestLapMs is the best VALID lap,
  // absent when there is none (delete-copy.ts drops the clause rather than
  // filling it with an em dash).
  const blastRadius = $derived<SessionBlastRadius | null>(
    session === null
      ? null
      : {
          startedAt: session.startedAt,
          lapCount: session.laps.length,
          bestLapMs: bestLap(session.laps)?.durationMs,
        },
  )

  // A repo that has not answered gets NO say in whether the warning appears: an
  // unloaded CoursesRepo reports the default settings (lastExportAt undefined),
  // and staying quiet on the strength of that is how someone deletes their only
  // copy believing it is backed up. Warn — but with NO cause named (plan 09 item
  // 8): `!loaded` is two states, not one. ensureLoaded() races loadSession() and
  // this body renders as soon as the session resolves, so on a healthy cold mount
  // this covers the ordinary still-loading window, where a read failure has not
  // happened. Where one HAS, the notice-error below prints the store's words —
  // once.
  const backupWarning = $derived(
    session === null
      ? null
      : coursesRepo.loaded
        ? deleteBackupWarning({
            sessionSummaries: [{ startedAt: session.startedAt }],
            lastExportAt: coursesRepo.settings.lastExportAt,
          })
        : DELETE_BACKUP_UNKNOWN_WARNING,
  )

  let deleting = $state(false)
  let failure = $state<string | null>(null)

  let exporting = $state(false)
  let exportNotice = $state<ExportNotice | null>(null)

  // The escape hatch, never a gate: it does not auto-continue into the delete,
  // and a failed export leaves the Delete button exactly as enabled as it was.
  async function exportBackup(): Promise<void> {
    if (exporting) return
    exporting = true
    exportNotice = null
    exportNotice = deleteExportNotice(await runExport(context), 'session')
    exporting = false
  }

  async function confirmDelete(): Promise<void> {
    // `exporting` is a hard gate: SessionsRepo.deleteSession does not go through
    // CoursesRepo's write queue, so a delete tapped mid-export removes the file
    // INSIDE runExport's strict session scan — which then rejects, correctly, on
    // a session it listed and can no longer read. By then this screen is being
    // unmounted by location.replace(), so the export failure is never rendered:
    // the session is gone and the user believes they took a backup.
    if (deleting || exporting || context.readOnly || !canDelete) return
    deleting = true
    failure = null

    // Idempotent at the seam, so the retry after a failure is safe. A single-file
    // delete has no partial state to describe: the repo's error is the whole
    // story, and the screen HOLDS on it rather than navigating.
    if (await sessionsRepo.deleteSession(sessionId)) {
      // replace(), not `location.hash =`: a push would leave this confirm route
      // — for a session that no longer exists — one Back tap away.
      location.replace(parentHash)
      return
    }

    failure = `Could not delete this session: ${sessionsRepo.lastError?.message ?? 'the store refused the delete'}. Try again.`
    deleting = false
  }
</script>

<main class="delete-session">
  <AppBar title="Delete session" backHref={parentHash} />

  {#if !loadSettled}
    <p class="loading">Loading session…</p>
  {:else if session === null || blastRadius === null}
    <!-- not-found also covers a quarantined (corrupt, set-aside) file. -->
    <p class="notice-error">
      This session does not exist — it may have been deleted, or its file was damaged and set aside.
    </p>
    <p><a href={hashFor({ id: 'home' })}>Back to courses</a></p>
  {:else}
    <h2>{DELETE_SESSION_TITLE}</h2>
    <p class="body">{deleteSessionBody(blastRadius)}</p>

    {#if !coursesRepo.loaded && coursesRepo.lastError !== null}
      <p class="notice-error">
        Your export history could not be read: {coursesRepo.lastError.message}
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
      <button
        class="btn btn-ghost"
        disabled={deleting}
        onclick={() => (location.hash = parentHash)}
      >
        Cancel
      </button>
      <button
        class="btn btn-danger"
        disabled={context.readOnly || !canDelete || deleting || exporting}
        onclick={() => void confirmDelete()}
      >
        {deleting ? 'Deleting…' : DELETE_SESSION_CONFIRM_LABEL}
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
