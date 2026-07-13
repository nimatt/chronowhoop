<script lang="ts">
  import { hashFor } from '../../core/routing/route'
  import { parseImportFile } from '../../core/storage/import'
  import { isStorageError, type ImportResult } from '../../core/storage/storage'
  import type { StorageContext } from '../data/storage-context'
  import { pwaInstall } from '../pwa-install.svelte'
  import { exportOutcomeNotice, runExport, type ExportNotice } from '../shared/export-action'
  import { directionArrow, formatMinLap } from './course-format'

  let { context }: { context: StorageContext } = $props()

  // The context (and its repo views) is a stable per-mount object; only the
  // views' fields are reactive.
  // svelte-ignore state_referenced_locally
  const repo = context.coursesRepo

  void repo.ensureLoaded()

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

  const plural = (count: number, noun: string) => `${String(count)} ${noun}${count === 1 ? '' : 's'}`

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
  // (repo failures land in lastError).
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
      await Promise.all([repo.reload(), context.sessionsRepo.refresh()])
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

<main>
  <h1>ChronoWhoop</h1>
  <p class="tagline">Tiny-whoop lap timer</p>

  {#if context.readOnly}
    <p class="banner notice-warning">
      Read-only: another tab is active. Close it to record sessions here.
    </p>
  {/if}

  <!-- Persistent indicator (plan 07 item 3): shown on every Home visit for as
       long as persist() has not been granted — denied or not yet answered. -->
  {#if context.persistence !== null && !context.persistence.persisted}
    <p class="persist-warning">
      Storage may be cleared by the browser — persistent storage was not granted. Export regularly
      to keep a backup.
    </p>
  {/if}

  {#if repo.lastError !== null}
    <p class="boxed notice-error">Storage error: {repo.lastError.message}</p>
  {/if}

  {#if !repo.loaded}
    <p class="hint">Loading courses…</p>
  {:else if repo.courses.length === 0}
    <div class="empty">
      <p>No courses yet — create your first course to start timing laps.</p>
    </div>
  {:else}
    <ul class="courses">
      {#each repo.courses as course (course.id)}
        <li>
          <a class="course-link" href={hashFor({ id: 'course', courseId: course.id })}>
            <span class="name">{course.name}</span>
            <span class="meta">
              {directionArrow(course.direction)} · min lap {formatMinLap(course.minLapTimeMs)}
            </span>
          </a>
          <a class="fly-button" href={hashFor({ id: 'fly', courseId: course.id })}>Fly</a>
        </li>
      {/each}
    </ul>
  {/if}

  {#if repo.loaded}
    <a class="new-course" href={hashFor({ id: 'new-course' })}>New course</a>
  {/if}

  <div class="data-actions">
    <div class="buttons">
      <button onclick={() => void exportAll()} disabled={exporting}>
        {exporting ? 'Exporting…' : 'Export data'}
      </button>
      <button onclick={() => importInput?.click()} disabled={importing}>
        {importing ? 'Importing…' : 'Import data'}
      </button>
      <input
        class="import-input"
        type="file"
        accept=".json,application/json"
        bind:this={importInput}
        onchange={onImportChange}
      />
      {#if pwaInstall.available}
        <button onclick={() => void pwaInstall.prompt()}>Install app</button>
      {/if}
    </div>
    {#if exportNotice !== null}
      <p class={exportNotice.ok ? 'action-ok' : 'action-failed notice-error'} role="status">
        {exportNotice.text}
      </p>
    {/if}
    {#if importNotice !== null}
      <p class={importNotice.ok ? 'action-ok' : 'action-failed notice-error'} role="status">
        {importNotice.text}
      </p>
    {/if}
  </div>

  <footer class="links">
    <a href={hashFor({ id: 'diag' })}>diagnostics</a>
    <a href={hashFor({ id: 'lab' })}>lab</a>
  </footer>
</main>

<style>
  main {
    text-align: center;
    padding-top: 3rem;
  }

  h1 {
    margin-bottom: 0.25rem;
  }

  .tagline {
    opacity: 0.7;
    margin-top: 0;
  }

  .banner {
    max-width: 26rem;
    margin: 1rem auto;
  }

  .persist-warning {
    max-width: 26rem;
    margin: 0.5rem auto;
    font-size: 0.8rem;
    color: #ffcf8a;
    opacity: 0.85;
  }

  .boxed {
    max-width: 26rem;
    margin: 1rem auto;
  }

  .hint,
  .empty {
    margin: 2.5rem auto 1.5rem;
    max-width: 26rem;
    opacity: 0.75;
  }

  .courses {
    list-style: none;
    padding: 0;
    max-width: 28rem;
    margin: 2rem auto 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }

  .courses li {
    display: flex;
    align-items: stretch;
    gap: 0.6rem;
  }

  .course-link {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.15rem;
    padding: 0.6rem 0.9rem;
    border-radius: 0.5rem;
    background: #16233c;
    border: 1px solid #2c3850;
    color: #e8edf7;
    text-decoration: none;
    text-align: left;
  }

  .course-link:hover {
    border-color: #7ea6ff;
  }

  .name {
    font-weight: 600;
    font-size: 1.05rem;
  }

  .meta {
    font-size: 0.85rem;
    opacity: 0.7;
  }

  .fly-button {
    display: flex;
    align-items: center;
    padding: 0 1.4rem;
    border-radius: 0.5rem;
    background: #1d3a6e;
    border: 1px solid #3b5fa3;
    color: #e8edf7;
    font-size: 1.1rem;
    font-weight: 600;
    text-decoration: none;
  }

  .fly-button:hover {
    border-color: #7ea6ff;
  }

  .new-course {
    display: inline-block;
    margin: 0.5rem 0 3rem;
    padding: 0.6rem 1.6rem;
    border-radius: 0.5rem;
    background: #16233c;
    border: 1px solid #2c3850;
    color: #e8edf7;
    font-size: 1rem;
    font-weight: 600;
    text-decoration: none;
  }

  .new-course:hover {
    border-color: #7ea6ff;
  }

  .data-actions {
    margin: 0 auto 1.5rem;
    max-width: 26rem;
  }

  .data-actions .buttons {
    display: flex;
    justify-content: center;
    flex-wrap: wrap;
    gap: 0.6rem;
  }

  .data-actions button {
    background: #16233c;
    color: #e8edf7;
    border: 1px solid #2c3850;
    border-radius: 0.375rem;
    padding: 0.45rem 1.2rem;
    font-size: 0.9rem;
    cursor: pointer;
  }

  .data-actions button:hover:not(:disabled) {
    border-color: #7ea6ff;
  }

  .data-actions button:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .import-input {
    display: none;
  }

  .action-ok {
    margin: 0.5rem 0 0;
    font-size: 0.85rem;
    color: #86efac;
    overflow-wrap: anywhere;
  }

  .action-failed {
    margin: 0.5rem 0 0;
  }

  .links {
    display: flex;
    justify-content: center;
    gap: 1.5rem;
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
      gap: 0.8rem;
      max-width: 46rem;
    }
  }
</style>
