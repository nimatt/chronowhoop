<script lang="ts">
  import type { CrossingDirection } from '../../core/detection/crossing-events'
  import { hashFor } from '../../core/routing/route'
  import type { StorageContext } from '../data/storage-context'
  import AppBar from '../shared/AppBar.svelte'

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
  const MIN_LAP_STEP_SECONDS = 0.5

  let name = $state('')
  // The "name is required" hint only shows once the field was touched or a
  // save was attempted — never on a pristine form (mockup 02 has no
  // validation state).
  let nameTouched = $state(false)
  let direction = $state<CrossingDirection>('ltr')
  // Always a defined number ≥ 0: the stepper is the only writer and clamps.
  let minLapSeconds = $state(DEFAULT_MIN_LAP_SECONDS)
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

  function stepMinLap(deltaSeconds: number): void {
    // Round to a tenth so repeated float steps can't drift the display.
    minLapSeconds = Math.max(0, Math.round((minLapSeconds + deltaSeconds) * 10) / 10)
  }

  const nameValid = $derived(name.trim().length > 0)
  const canSave = $derived(nameValid && seeded && !saving && !context.readOnly)

  const cancelHash = $derived(
    editingId === undefined ? hashFor({ id: 'home' }) : hashFor({ id: 'course', courseId: editingId }),
  )

  async function save() {
    nameTouched = true
    if (!canSave) return
    saving = true
    try {
      const fields = {
        name: name.trim(),
        direction,
        minLapTimeMs: Math.round(minLapSeconds * 1000),
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
  <AppBar title={editingId === undefined ? 'New course' : 'Edit course'} backHref={cancelHash} />

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
      <p class="loading">Loading course…</p>
    {/if}
  {:else}
    <form
      onsubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <div class="stack">
        <div class="field">
          <label class="label" for="course-name">Name</label>
          <input
            id="course-name"
            class="val"
            type="text"
            bind:value={name}
            oninput={() => (nameTouched = true)}
            placeholder="Basement 3-gate"
          />
          {#if nameTouched && !nameValid}
            <span class="field-hint">A name is required.</span>
          {/if}
        </div>

        <div class="field">
          <span class="label">Crossing direction</span>
          <div class="seg">
            <button
              type="button"
              class="opt"
              class:sel={direction === 'ltr'}
              aria-pressed={direction === 'ltr'}
              onclick={() => (direction = 'ltr')}
            >
              <span class="arw">→</span>
              <span>Left to right</span>
              <small>{direction === 'ltr' ? 'counts this way' : ' '}</small>
            </button>
            <button
              type="button"
              class="opt"
              class:sel={direction === 'rtl'}
              aria-pressed={direction === 'rtl'}
              onclick={() => (direction = 'rtl')}
            >
              <span class="arw">←</span>
              <span>Right to left</span>
              <small>{direction === 'rtl' ? 'counts this way' : ' '}</small>
            </button>
          </div>
          <span class="hint">
            Which way through the gate counts as a lap. The other direction is ignored.
          </span>
        </div>

        <div class="field">
          <span class="label">Minimum lap time</span>
          <div class="stepper">
            <button
              type="button"
              aria-label="Decrease minimum lap time"
              disabled={minLapSeconds <= 0}
              onclick={() => stepMinLap(-MIN_LAP_STEP_SECONDS)}
            >
              −
            </button>
            <div class="n">{minLapSeconds.toFixed(1)}<small> s</small></div>
            <button
              type="button"
              aria-label="Increase minimum lap time"
              onclick={() => stepMinLap(MIN_LAP_STEP_SECONDS)}
            >
              +
            </button>
          </div>
          <span class="hint">
            Crossings closer together than this are treated as debounce noise.
          </span>
        </div>

        {#if repo.lastError !== null}
          <p class="notice-error">Storage error: {repo.lastError.message}</p>
        {/if}
      </div>

      <div class="cta">
        <button type="submit" class="btn btn-primary" disabled={!canSave}>
          {editingId === undefined ? 'Create course' : 'Save'}
        </button>
      </div>
    </form>
  {/if}
</main>

<style>
  /* Pin the CTA to the bottom of the viewport on phones (mockup 02): the
     form fills the remaining height and the CTA rides at its end. The 5.5rem
     accounts for main's own vertical padding (App.svelte). */
  main.course-form {
    display: flex;
    flex-direction: column;
    gap: 14px;
    min-height: calc(100dvh - 5.5rem);
  }

  form {
    flex: 1;
    display: flex;
    flex-direction: column;
    margin-top: 6px;
  }

  input.val::placeholder {
    color: var(--c-dim2);
  }

  .field-hint {
    font-size: 0.8rem;
    color: var(--c-record);
  }

  .notice-error,
  .notice-warning {
    margin: 0;
  }

  .loading {
    color: var(--c-dim);
  }

  .cta {
    margin-top: auto;
    padding-top: 1.5rem;
  }
</style>
