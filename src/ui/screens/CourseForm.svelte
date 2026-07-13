<script lang="ts">
  import type { CrossingDirection } from '../../core/detection/crossing-events'
  import { hashFor } from '../../core/routing/route'
  import type { StorageContext } from '../data/storage-context'

  // courseId present → edit; absent → new (routes #/course/<id>/edit and
  // #/course/new). Deletion is out of scope per the product spec.
  let { context, courseId }: { context: StorageContext; courseId?: string } = $props()

  // svelte-ignore state_referenced_locally
  const repo = context.coursesRepo
  // The route (and with it this component) is replaced on navigation, so the
  // edit target is fixed per mount.
  // svelte-ignore state_referenced_locally
  const editingId = courseId

  void repo.ensureLoaded()

  const DEFAULT_MIN_LAP_SECONDS = 3

  let name = $state('')
  let direction = $state<CrossingDirection>('ltr')
  // number|undefined: an emptied number input binds undefined, which just
  // reads as invalid.
  let minLapSeconds = $state<number | undefined>(DEFAULT_MIN_LAP_SECONDS)
  let saving = $state(false)
  let seeded = $state(editingId === undefined)

  const editedCourse = $derived(editingId === undefined ? undefined : repo.courseById(editingId))
  const notFound = $derived(editingId !== undefined && repo.loaded && editedCourse === undefined)

  // Edit mode: seed the fields once from the stored course as soon as the
  // load delivers it; later reactive changes must not clobber user input.
  $effect(() => {
    if (seeded || editedCourse === undefined) return
    name = editedCourse.name
    direction = editedCourse.direction
    minLapSeconds = editedCourse.minLapTimeMs / 1000
    seeded = true
  })

  const nameValid = $derived(name.trim().length > 0)
  const minLapValid = $derived(
    minLapSeconds !== undefined && Number.isFinite(minLapSeconds) && minLapSeconds >= 0,
  )
  const canSave = $derived(nameValid && minLapValid && seeded && !saving && !context.readOnly)

  const cancelHash = $derived(
    editingId === undefined ? hashFor({ id: 'home' }) : hashFor({ id: 'course', courseId: editingId }),
  )

  async function save() {
    if (!canSave) return
    saving = true
    try {
      const fields = {
        name: name.trim(),
        direction,
        minLapTimeMs: Math.round((minLapSeconds ?? 0) * 1000),
      }
      if (editingId === undefined) {
        const created = await repo.createCourse(fields)
        if (created !== null) location.hash = hashFor({ id: 'course', courseId: created.id })
      } else if (editedCourse !== undefined) {
        const ok = await repo.saveCourse({ ...editedCourse, ...fields })
        if (ok) location.hash = hashFor({ id: 'course', courseId: editingId })
      }
    } finally {
      saving = false
    }
  }
</script>

<main class="course-form">
  <header>
    <h1>{editingId === undefined ? 'New course' : 'Edit course'}</h1>
    <a href={cancelHash}>Cancel</a>
  </header>

  {#if context.readOnly}
    <p class="notice-warning">Read-only: another tab is active — changes cannot be saved.</p>
  {/if}

  {#if notFound}
    <p class="notice-error">This course does not exist.</p>
    <a href={hashFor({ id: 'home' })}>Back to courses</a>
  {:else if !seeded}
    {#if repo.lastError !== null}
      <p class="notice-error">Storage error: {repo.lastError.message}</p>
    {:else}
      <p class="hint">Loading course…</p>
    {/if}
  {:else}
    <form
      onsubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <label>
        Name
        <input type="text" bind:value={name} placeholder="Basement 3-gate" />
      </label>
      {#if !nameValid}
        <p class="field-hint">A name is required.</p>
      {/if}

      <label>
        Direction that counts
        <select bind:value={direction}>
          <option value="ltr">left → right</option>
          <option value="rtl">right → left</option>
        </select>
      </label>

      <label>
        Minimum lap time (seconds)
        <input type="number" bind:value={minLapSeconds} min="0" step="0.1" />
      </label>
      {#if !minLapValid}
        <p class="field-hint">Must be a number ≥ 0.</p>
      {/if}

      {#if repo.lastError !== null}
        <p class="notice-error">Storage error: {repo.lastError.message}</p>
      {/if}

      <div class="controls">
        <button type="submit" class="primary" disabled={!canSave}>Save</button>
        <a class="cancel" href={cancelHash}>Cancel</a>
      </div>
    </form>
  {/if}
</main>

<style>
  header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: 0.75rem;
  }

  h1 {
    margin: 0;
    font-size: 1.4rem;
  }

  form {
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
    max-width: 24rem;
  }

  label {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    font-size: 0.95rem;
  }

  input,
  select {
    background: #16233c;
    color: #e8edf7;
    border: 1px solid #2c3850;
    border-radius: 0.375rem;
    padding: 0.45rem 0.6rem;
    font-size: 1rem;
  }

  input:focus,
  select:focus {
    outline: none;
    border-color: #7ea6ff;
  }

  .field-hint {
    margin: -0.5rem 0 0;
    font-size: 0.8rem;
    color: #ffcf8a;
  }

  .controls {
    display: flex;
    align-items: center;
    gap: 0.9rem;
    margin-top: 0.4rem;
  }

  button {
    background: #1d3a6e;
    color: #e8edf7;
    border: 1px solid #3b5fa3;
    border-radius: 0.375rem;
    padding: 0.5rem 1.4rem;
    font-size: 1rem;
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
  }

</style>
