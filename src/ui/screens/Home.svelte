<script lang="ts">
  import { hashFor } from '../../core/routing/route'
  import { parseImportFile } from '../../core/storage/import'
  import { isStorageError, type ImportResult } from '../../core/storage/storage'
  import type { StorageContext } from '../data/storage-context'
  import { pwaInstall } from '../pwa-install.svelte'
  import AppBar from '../shared/AppBar.svelte'
  import Chip from '../shared/Chip.svelte'
  import IconButton from '../shared/IconButton.svelte'
  import RecTiles from '../shared/RecTiles.svelte'
  import { exportOutcomeNotice, runExport, type ExportNotice } from '../shared/export-action'
  import { formatShortDate } from './course-format'
  import { computeCourseStats, type CourseStats } from './course-stats'

  let { context }: { context: StorageContext } = $props()

  // The context (and its repo views) is a stable per-mount object; only the
  // views' fields are reactive.
  // svelte-ignore state_referenced_locally
  const repo = context.coursesRepo
  // svelte-ignore state_referenced_locally
  const sessionsRepo = context.sessionsRepo

  void repo.ensureLoaded()

  // Per-course all-time records need lap bodies, so this is a full-scan of
  // every session (course-stats.ts) — computed once per mount, cached here,
  // and recomputed after an import lands new sessions. refresh() rather than
  // ensureLoaded(): flights persist sessions behind the repo's back.
  let statsByCourse = $state<ReadonlyMap<string, CourseStats> | null>(null)

  async function loadStats(): Promise<void> {
    await sessionsRepo.refresh()
    statsByCourse = await computeCourseStats(sessionsRepo.summaries, (id) =>
      sessionsRepo.loadSession(id),
    )
  }
  void loadStats()

  const plural = (count: number, noun: string) => `${String(count)} ${noun}${count === 1 ? '' : 's'}`

  function courseMeta(stats: CourseStats | undefined): string {
    if (stats === undefined || stats.sessionCount === 0 || stats.lastFlownAt === undefined) {
      return 'No sessions yet'
    }
    return `${plural(stats.sessionCount, 'session')} · last flown ${formatShortDate(stats.lastFlownAt)}`
  }

  let exporting = $state(false)
  let exportNotice = $state<ExportNotice | null>(null)

  // Share sheet on phones, anchor download elsewhere; lastExportAt recording
  // and the notice copy live in export-action (shared with the post-session
  // backup nudge).
  async function exportAll(): Promise<void> {
    if (exporting) return
    exporting = true
    exportNotice = null
    exportNotice = exportOutcomeNotice(await runExport(context))
    exporting = false
  }

  let importing = $state(false)
  let importNotice = $state<{ ok: boolean; text: string } | null>(null)
  let importInput: HTMLInputElement | undefined

  function describeImportResult(result: ImportResult): string {
    const added = `Added ${plural(result.coursesAdded, 'course')} and ${plural(result.sessionsAdded, 'session')}`
    const skipped = `skipped ${plural(result.coursesSkipped, 'course')} and ${plural(result.sessionsSkipped, 'session')} already present`
    return `${added}; ${skipped}.`
  }

  function describeImportError(error: unknown): string {
    if (isStorageError(error)) {
      // 'unsupported-version' already carries the "update the app" phrasing.
      if (error.kind === 'unsupported-version') return error.message
      if (error.kind === 'corrupt') return `Not a valid export file — ${error.message}`
    }
    return `Import failed: ${error instanceof Error ? error.message : String(error)}`
  }

  // Import (plan 07 item 2, UI half): parse/validate, merge through the
  // storage seam, then refresh BOTH repos — importAll writes behind their
  // backs (the invalidation rule in storage-context.ts). The refreshes run
  // in finally: a mid-import failure may have landed partial writes, and the
  // UI must show them rather than a stale snapshot. Refreshes never reject
  // (repo failures land in lastError). loadStats covers the sessions-repo
  // refresh and recomputes the card records from the merged data.
  async function importFile(file: File): Promise<void> {
    importing = true
    importNotice = null
    try {
      const envelope = parseImportFile(await file.text())
      const result = await context.storage.importAll(envelope)
      importNotice = { ok: true, text: describeImportResult(result) }
    } catch (error) {
      importNotice = { ok: false, text: describeImportError(error) }
    } finally {
      await Promise.all([repo.reload(), loadStats()])
      importing = false
    }
  }

  function onImportChange(event: Event): void {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    // Reset so picking the same file again re-fires change (re-import after
    // a mid-import failure is the documented recovery path).
    input.value = ''
    if (file !== undefined) void importFile(file)
  }
</script>

<main class="home">
  <AppBar title="Courses">
    {#snippet actions()}
      <IconButton label="Import" disabled={importing} onclick={() => importInput?.click()}>
        <svg class="ic" viewBox="0 0 24 24">
          <path d="M12 15V3M8 7l4-4 4 4M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
        </svg>
      </IconButton>
      <IconButton label="Export" disabled={exporting} onclick={() => void exportAll()}>
        <svg class="ic" viewBox="0 0 24 24">
          <path d="M12 3v12M8 11l4 4 4-4M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
        </svg>
      </IconButton>
    {/snippet}
  </AppBar>

  <input
    class="import-input"
    type="file"
    accept=".json,application/json"
    bind:this={importInput}
    onchange={onImportChange}
  />

  {#if context.readOnly}
    <p class="notice-warning">
      Read-only: another tab is active. Close it to record sessions here.
    </p>
  {/if}

  <!-- Persistence status (plan 07 item 3): the mockup's ok-chip when persist()
       was granted; the standing warning stays for as long as it wasn't
       (denied or not yet answered). -->
  {#if context.persistence !== null && context.persistence.persisted}
    <div class="statusrow">
      <Chip variant="ok">
        {#snippet icon()}
          <svg class="ic-sm" viewBox="0 0 24 24">
            <path d="M12 3l7 3v5c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6z" />
            <path d="M9 12l2 2 4-4" />
          </svg>
        {/snippet}
        Storage persisted
      </Chip>
      {#if pwaInstall.available}
        <button class="install" onclick={() => void pwaInstall.prompt()}>Install app</button>
      {/if}
    </div>
  {:else}
    {#if context.persistence !== null}
      <p class="notice-warning">
        Storage may be cleared by the browser — persistent storage was not granted. Export
        regularly to keep a backup.
      </p>
    {/if}
    {#if pwaInstall.available}
      <div class="statusrow">
        <button class="install" onclick={() => void pwaInstall.prompt()}>Install app</button>
      </div>
    {/if}
  {/if}

  {#if exportNotice !== null}
    <p class={exportNotice.ok ? 'action-ok' : 'notice-error'} role="status">
      {exportNotice.text}
    </p>
  {/if}
  {#if importNotice !== null}
    <p class={importNotice.ok ? 'action-ok' : 'notice-error'} role="status">
      {importNotice.text}
    </p>
  {/if}

  {#if repo.lastError !== null}
    <p class="notice-error">Storage error: {repo.lastError.message}</p>
  {/if}

  {#if !repo.loaded}
    <p class="loading">Loading courses…</p>
  {:else if repo.courses.length === 0}
    <div class="card empty">
      <p>No courses yet — create your first course to start timing laps.</p>
    </div>
  {:else}
    <div class="list courses">
      {#each repo.courses as course (course.id)}
        {@const stats = statsByCourse?.get(course.id)}
        <a class="card course course-link" href={hashFor({ id: 'course', courseId: course.id })}>
          <div class="top">
            <div>
              <div class="cname">{course.name}</div>
              <div class="meta">{courseMeta(stats)}</div>
            </div>
            <svg class="ic chev" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6" /></svg>
          </div>
          <RecTiles
            bestLapMs={stats?.records.bestLap?.durationMs}
            bestThreeMs={stats?.records.bestThreeConsecutive?.totalMs}
          />
        </a>
      {/each}
    </div>
  {/if}

  {#if repo.loaded}
    <a class="btn btn-primary new-course" href={hashFor({ id: 'new-course' })}>
      <svg class="ic plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg>
      New course
    </a>
  {/if}

  <footer class="links">
    <a href={hashFor({ id: 'diag' })}>diagnostics</a>
    <a href={hashFor({ id: 'lab' })}>lab</a>
  </footer>
</main>

<style>
  main {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .import-input {
    display: none;
  }

  .statusrow {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.6rem;
  }

  .install {
    background: var(--c-panel);
    color: var(--c-ink);
    border: 1px solid var(--c-line);
    border-radius: 999px;
    padding: 5px 12px;
    font-size: 0.8rem;
    cursor: pointer;
  }

  .install:hover {
    border-color: var(--c-signal-dim);
  }

  .notice-warning,
  .notice-error,
  .action-ok,
  .loading {
    margin: 0;
  }

  .action-ok {
    font-size: 0.85rem;
    color: var(--c-signal);
    overflow-wrap: anywhere;
  }

  .loading,
  .empty {
    color: var(--c-dim);
  }

  .empty p {
    margin: 0;
  }

  .courses {
    gap: 12px;
  }

  a.course-link {
    display: flex;
    flex-direction: column;
    gap: 12px;
    color: inherit;
    text-decoration: none;
  }

  a.course-link:hover {
    border-color: var(--c-signal-dim);
  }

  .top {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 10px;
  }

  .cname {
    font-size: 1.04rem;
    font-weight: 600;
    letter-spacing: -0.01em;
  }

  .meta {
    font-family: var(--font-mono);
    font-size: 0.68rem;
    color: var(--c-dim);
    margin-top: 3px;
  }

  .chev {
    color: var(--c-dim2);
    flex: none;
  }

  a.new-course {
    text-decoration: none;
  }

  .plus {
    width: 20px;
    height: 20px;
  }

  .links {
    display: flex;
    gap: 1.5rem;
    margin-top: 1rem;
    font-size: 0.85rem;
    opacity: 0.6;
  }

  /* Desktop (48rem breakpoint, see App.svelte): two course cards per row. */
  @media (min-width: 48rem) {
    main {
      max-width: 56rem;
    }

    .courses {
      display: grid;
      grid-template-columns: 1fr 1fr;
      align-items: start;
    }

    a.new-course {
      width: calc((100% - 12px) / 2);
    }
  }
</style>
