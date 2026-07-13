<script lang="ts">
  import type { CameraMediaDevicesLike } from '../../core/camera/camera-service'
  import type { SessionDetectionConfig } from '../../core/domain/types'
  import { hashFor } from '../../core/routing/route'
  import type { StorageContext } from '../data/storage-context'
  import FlyFlow from '../fly/FlyFlow.svelte'
  import type { FlySession } from '../fly/fly-session'

  // The #/fly/<courseId> loader: resolves the course and the detection-config
  // prefill (the course's most recent session's snapshot, product.md setup
  // step) BEFORE mounting the actual flow, so FlyFlow can create its session
  // synchronously against a real Course. App keys this screen on courseId.
  let {
    context,
    courseId,
    mediaDevices,
    onsession,
  }: {
    context: StorageContext
    courseId: string
    mediaDevices?: CameraMediaDevicesLike
    onsession?: (session: FlySession) => void
  } = $props()

  // svelte-ignore state_referenced_locally
  const coursesRepo = context.coursesRepo

  void coursesRepo.ensureLoaded()

  // One-shot: undefined while loading; after that the snapshot or null (no
  // previous session, or the lookup failed — both fall back to defaults).
  let prefill = $state<SessionDetectionConfig | null | undefined>(undefined)
  // svelte-ignore state_referenced_locally
  void context.sessionsRepo.latestForCourse(courseId).then((latest) => {
    prefill = latest?.detectionConfig ?? null
  })

  const course = $derived(coursesRepo.courseById(courseId))
</script>

{#if !coursesRepo.loaded || (course !== undefined && prefill === undefined)}
  <main>
    {#if coursesRepo.lastError !== null}
      <p class="notice-error">Storage error: {coursesRepo.lastError.message}</p>
    {:else}
      <p class="hint">Loading course…</p>
    {/if}
  </main>
{:else if course === undefined}
  <main>
    <p class="notice-error">This course does not exist.</p>
    <a href={hashFor({ id: 'home' })}>Back to courses</a>
  </main>
{:else}
  <FlyFlow
    {context}
    {course}
    initialDetectionConfig={prefill ?? undefined}
    {mediaDevices}
    {onsession}
  />
{/if}

<style>
  .hint {
    opacity: 0.75;
  }
</style>
