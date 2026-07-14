<script lang="ts">
  import type { CameraMediaDevicesLike } from '../../core/camera/camera-service'
  import type { Course, SessionDetectionConfig } from '../../core/domain/types'
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
    initialNote,
    mediaDevices,
    matchMedia,
    onsession,
  }: {
    context: StorageContext
    course: Course
    initialDetectionConfig?: SessionDetectionConfig
    initialNote?: string
    mediaDevices?: CameraMediaDevicesLike
    matchMedia?: OrientationMatchMedia
    onsession?: (session: FlySession) => void
  } = $props()

  // Created once per mount from the initial prop values — the seam is
  // deliberately not reactive.
  // svelte-ignore state_referenced_locally
  const session = createFlySession({
    course,
    storage: context.sessionWriter,
    ...(initialDetectionConfig !== undefined ? { initialDetectionConfig } : {}),
    ...(initialNote !== undefined ? { initialNote } : {}),
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
  // asynchronously after load, so the flow polls context.liveReadOnly(), which
  // reads the storage instance at call time, and re-derives it at arm time.
  // svelte-ignore state_referenced_locally
  let readOnly = $state(context.liveReadOnly())
  $effect(() => {
    const timer = setInterval(() => {
      readOnly = context.liveReadOnly()
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
    readOnly = context.liveReadOnly()
    if (readOnly) return
    session.arm()
  }
</script>

<main class="fly">
  <!-- Orientation binding (detection.md): the warning renders over every
       camera-active phase — during setup the ROI calibration is bound to the
       orientation too, and while armed the detector is detached until the
       device is rotated back. -->
  {#if session.orientationMismatch && session.boundOrientation !== null && session.phase !== 'stopped'}
    <p class="banner notice-warning orientation-banner" role="alert">
      Rotate the phone back to {session.boundOrientation} — detection is paused until the setup
      orientation is restored.
    </p>
  {/if}

  {#if session.phase === 'setup' || session.phase === 'test'}
    {#if readOnly}
      <p class="banner notice-warning" role="alert">
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
  /* The global main padding reserves 4rem at the bottom for Home's FAB; the
     fly flow has none, and its panels pin primary actions to the viewport
     bottom (armed STOP, test-mode ARM), so keep the reserve symmetric. */
  main.fly {
    padding-bottom: 1.5rem;
  }

  .banner {
    margin: 0.75rem 0;
  }

  /* Must be legible at a glance from beside the gate. */
  .orientation-banner {
    font-size: 1.1rem;
    font-weight: 600;
  }

  /* Shared styling for the phase panels (scoped styles don't reach child
     components, so these are :global under the screen's own class). The
     mockup-vocabulary .btn buttons and the AppBar back button style
     themselves; everything else (small inline actions: Retry, Apply,
     Suggest trigger, Dismiss, Export now) gets this quiet panel look. */
  .fly :global(button:not(.btn):not(.backbtn)) {
    background: var(--c-panel);
    color: var(--c-ink);
    border: 1px solid var(--c-line);
    border-radius: 10px;
    padding: 0.4rem 0.9rem;
    font-size: 0.9rem;
    cursor: pointer;
  }

  .fly :global(button:hover:not(:disabled)) {
    border-color: var(--c-signal-dim);
  }

  .fly :global(button:disabled) {
    opacity: 0.45;
    cursor: default;
  }

  .fly :global(.controls) {
    display: flex;
    flex-wrap: wrap;
    gap: 0.6rem;
    align-items: center;
    margin: 0.6rem 0;
  }

  /* The global .hint token is caption-sized; fly guidance lines are read from
     beside the gate, so bump them a notch. */
  .fly :global(.hint) {
    font-size: 0.85rem;
  }
</style>
