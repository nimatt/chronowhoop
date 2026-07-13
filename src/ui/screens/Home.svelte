<script lang="ts">
  import { hashFor } from '../../core/routing/route'
  import { exportAllToBlob } from '../../core/storage/export'
  import type { StorageContext } from '../data/storage-context'
  import { downloadBlob } from '../shared/download'
  import { directionArrow, formatMinLap } from './course-format'

  let { context }: { context: StorageContext } = $props()

  // The context (and its repo views) is a stable per-mount object; only the
  // views' fields are reactive.
  // svelte-ignore state_referenced_locally
  const repo = context.coursesRepo

  void repo.ensureLoaded()

  let exporting = $state(false)
  let exportNotice = $state<{ ok: boolean; text: string } | null>(null)

  // Working export (plan 06 item 6): assemble the envelope, deliver it as an
  // anchor download, then record lastExportAt (the Phase 7 backup-nudge seam)
  // through the repo so the settings mirror updates with it. Recording is
  // fire-and-forget: the export already reached the user; a stale
  // lastExportAt only costs an extra nudge.
  async function exportAll(): Promise<void> {
    if (exporting) return
    exporting = true
    exportNotice = null
    try {
      const { blob, filename, exportedAt } = await exportAllToBlob(context.storage)
      downloadBlob(filename, blob)
      exportNotice = { ok: true, text: `Exported ${filename}` }
      void repo.updateSettings({ lastExportAt: exportedAt })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      exportNotice = { ok: false, text: `Export failed: ${message}` }
    } finally {
      exporting = false
    }
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

  {#if context.persistence !== null && !context.persistence.persisted}
    <p class="persist-warning">
      Storage is not yet persistent — the browser may evict data under pressure. Export regularly.
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

  <div class="export">
    <button onclick={() => void exportAll()} disabled={exporting}>
      {exporting ? 'Exporting…' : 'Export data'}
    </button>
    {#if exportNotice !== null}
      <p class={exportNotice.ok ? 'export-ok' : 'export-failed notice-error'} role="status">
        {exportNotice.text}
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

  .export {
    margin: 0 auto 1.5rem;
    max-width: 26rem;
  }

  .export button {
    background: #16233c;
    color: #e8edf7;
    border: 1px solid #2c3850;
    border-radius: 0.375rem;
    padding: 0.45rem 1.2rem;
    font-size: 0.9rem;
    cursor: pointer;
  }

  .export button:hover:not(:disabled) {
    border-color: #7ea6ff;
  }

  .export button:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .export-ok {
    margin: 0.5rem 0 0;
    font-size: 0.85rem;
    color: #86efac;
    overflow-wrap: anywhere;
  }

  .export-failed {
    margin: 0.5rem 0 0;
  }

  .links {
    display: flex;
    justify-content: center;
    gap: 1.5rem;
    font-size: 0.85rem;
    opacity: 0.6;
  }
</style>
