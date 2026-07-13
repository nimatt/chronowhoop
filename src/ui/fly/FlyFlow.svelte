<script lang="ts">
  import type { CameraMediaDevicesLike } from '../../core/camera/camera-service'
  import type { Course, SessionDetectionConfig } from '../../core/domain/types'
  import { hashFor } from '../../core/routing/route'
  import type { StorageContext } from '../data/storage-context'
  import { createFlySession } from './fly-session.svelte'
  import type { FlySession } from './fly-session'
  import type { OrientationMatchMedia } from './orientation-binding'
  import FlyArmedPanel from './FlyArmedPanel.svelte'
  import FlySetupPanel from './FlySetupPanel.svelte'
  import FlyStoppedPanel from './FlyStoppedPanel.svelte'
  import FlyTestPanel from './FlyTestPanel.svelte'

  // Mounted by Fly.svelte once the course (and the prefill snapshot) has
  // loaded; the props are captured at mount — the flow never re-targets.
  // mediaDevices and matchMedia are the browser tests' capture/orientation
  // seams; onsession hands the test the created session (for the
  // crossing-injection seam). The real route passes none of them.
  let {
    context,
    course,
    initialDetectionConfig,
    mediaDevices,
    matchMedia,
    onsession,
  }: {
    context: StorageContext
    course: Course
    initialDetectionConfig?: SessionDetectionConfig
    mediaDevices?: CameraMediaDevicesLike
    matchMedia?: OrientationMatchMedia
    onsession?: (session: FlySession) => void
  } = $props()

  // Created once per mount from the initial prop values — the seam is
  // deliberately not reactive.
  // svelte-ignore state_referenced_locally
  const session = createFlySession({
    course,
    storage: context.storage,
    ...(initialDetectionConfig !== undefined ? { initialDetectionConfig } : {}),
    ...(mediaDevices !== undefined ? { mediaDevices } : {}),
    ...(matchMedia !== undefined ? { matchMedia } : {}),
    // Read at announcement time; the toggle below persists the setting.
    speechEnabled: () => context.coursesRepo.settings.speechEnabled,
    // The most recently FLOWN course (fire-and-forget; arm never awaits).
    onArmed: () => void context.coursesRepo.updateSettings({ lastCourseId: course.id }),
  })
  // svelte-ignore state_referenced_locally
  onsession?.(session)

  $effect(() => () => session.destroy())

  // Read-only gating (a second tab must not record a session that can never
  // save). context.readOnly is a mirror that only refreshes after repository
  // operations, and the underlying Web Locks answer settles — and can flip —
  // asynchronously after load, so the flow polls the live answer off the
  // storage instance (OpfsStorage exposes it; storages without the concept
  // fall back to the context's answer) and re-derives it at arm time.
  function liveReadOnly(): boolean {
    const live = (context.storage as { readOnly?: unknown }).readOnly
    return typeof live === 'boolean' ? live : context.readOnly
  }
  let readOnly = $state(liveReadOnly())
  $effect(() => {
    const timer = setInterval(() => {
      readOnly = liveReadOnly()
    }, 500)
    return () => clearInterval(timer)
  })

  // Arming is also gated while the PREVIOUS session's save is pending: the
  // persister coalesces globally, so re-arming then would drop the unsaved
  // tail (fly-session.arm() enforces the same guard).
  const savingPrevious = $derived(
    (session.phase === 'setup' || session.phase === 'test') && session.persisterState.pending,
  )
  // … and while the device has left the setup orientation (detection.md
  // "Orientation" — the session refuses arm() then too).
  const armDisabled = $derived(readOnly || savingPrevious || session.orientationMismatch)

  function arm(): void {
    // The lock answer settles async, so the polled value may be stale for up
    // to one tick — re-derive at the moment of truth.
    readOnly = liveReadOnly()
    if (readOnly) return
    session.arm()
  }
</script>

<main class="fly">
  <header>
    <h1>{course.name}</h1>
    <!-- Leaving mid-flight must stay deliberate (browser back), but setup and
         stopped are the natural entry/exit points of the loop. -->
    {#if session.phase === 'setup' || session.phase === 'stopped'}
      <nav>
        <a href={hashFor({ id: 'course', courseId: course.id })}>Course</a>
        <a href={hashFor({ id: 'home' })}>Home</a>
      </nav>
    {/if}
  </header>

  <!-- Orientation binding (detection.md): the warning renders over every
       camera-active phase — during setup the ROI calibration is bound to the
       orientation too, and while armed the detector is detached until the
       device is rotated back. -->
  {#if session.orientationMismatch && session.boundOrientation !== null && session.phase !== 'stopped'}
    <p class="banner orientation-banner" role="alert">
      Rotate the phone back to {session.boundOrientation} — detection is paused until the setup
      orientation is restored.
    </p>
  {/if}

  {#if session.phase === 'setup' || session.phase === 'test'}
    {#if readOnly}
      <p class="banner" role="alert">
        Read-only: another tab is active, so sessions recorded here could not be saved — arming is
        disabled. Close the other tab to record sessions here.
      </p>
    {:else if savingPrevious}
      <p class="hint">Saving previous session… arming is available once it finishes.</p>
    {/if}
  {/if}

  {#if session.phase === 'setup'}
    <FlySetupPanel
      {session}
      {arm}
      {armDisabled}
      speechEnabled={context.coursesRepo.settings.speechEnabled}
      onSpeechEnabledChange={(enabled) =>
        void context.coursesRepo.updateSettings({ speechEnabled: enabled })}
    />
  {:else if session.phase === 'test'}
    <FlyTestPanel {session} {arm} {armDisabled} />
  {:else if session.phase === 'armed'}
    <FlyArmedPanel {session} />
  {:else}
    <FlyStoppedPanel {session} {context} />
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

  nav {
    display: flex;
    gap: 0.9rem;
  }

  .banner {
    margin: 0.75rem 0;
    padding: 0.6rem 0.8rem;
    border-radius: 0.375rem;
    background: #4a3413;
    border: 1px solid #8a6420;
    color: #ffd27e;
    font-size: 0.95rem;
  }

  /* Must be legible at a glance from beside the gate. */
  .orientation-banner {
    font-size: 1.1rem;
    font-weight: 600;
  }

  /* Shared styling for the phase panels (scoped styles don't reach child
     components, so these are :global under the screen's own class). */
  .fly :global(button) {
    background: #16233c;
    color: #e8edf7;
    border: 1px solid #2c3850;
    border-radius: 0.375rem;
    padding: 0.4rem 0.9rem;
    font-size: 0.95rem;
    cursor: pointer;
  }

  .fly :global(button:hover:not(:disabled)) {
    border-color: #7ea6ff;
  }

  .fly :global(button:disabled) {
    opacity: 0.45;
    cursor: default;
  }

  .fly :global(button.primary) {
    background: #1d3a6e;
    border-color: #3b5fa3;
    font-weight: 600;
  }

  .fly :global(.controls) {
    display: flex;
    flex-wrap: wrap;
    gap: 0.6rem;
    align-items: center;
    margin: 0.6rem 0;
  }

  .fly :global(.hint) {
    font-size: 0.9rem;
    opacity: 0.75;
    margin: 0.4rem 0;
  }

  .fly :global(.error) {
    padding: 0.5rem 0.7rem;
    border-radius: 0.375rem;
    background: #3f1520;
    border: 1px solid #7c2b3d;
    color: #ff8aa0;
    font-size: 0.9rem;
    overflow-wrap: anywhere;
  }
</style>
