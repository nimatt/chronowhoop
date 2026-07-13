<script lang="ts">
  import { hashFor } from '../../core/routing/route'
  import { fmtNumber } from '../diag/format'
  import { directionLabel, formatMinLap } from '../screens/course-format'
  import AppBar from '../shared/AppBar.svelte'
  import Chip from '../shared/Chip.svelte'
  import MeterFrame from '../shared/MeterFrame.svelte'
  import { drawNormalizedStripBars } from '../shared/energy-bars'
  import { normalizeEnergies } from '../shared/energy-math'
  import RoiOverlay from '../shared/RoiOverlay.svelte'
  import { createTriggerCollection } from '../shared/trigger-collection.svelte'
  import WakeLockWarning from '../shared/WakeLockWarning.svelte'
  import type { FlySession } from './fly-session'

  let {
    session,
    arm,
    armDisabled,
    speechEnabled,
    onSpeechEnabledChange,
  }: {
    session: FlySession
    // FlyFlow's guarded arm: re-checks read-only at click time and skips
    // session.arm() while another tab holds the writer lock.
    arm: () => void
    // Read-only storage or the previous session still saving (FlyFlow
    // renders the explanatory banner/note above the panel).
    armDisabled: boolean
    speechEnabled: boolean
    onSpeechEnabledChange: (enabled: boolean) => void
  } = $props()

  let videoEl = $state<HTMLVideoElement | null>(null)
  let barsCanvas: HTMLCanvasElement | null = null
  // Honest "· auto" tag on the trigger readout: only right after applying the
  // collector's suggestion, cleared the moment the slider moves.
  let triggerAuto = $state(false)

  const cameraState = $derived(session.cameraState)

  $effect(() => {
    if (videoEl !== null && cameraState.status === 'active') {
      videoEl.srcObject = cameraState.stream
    }
  })

  // Per-frame strip bars draw straight to the canvas (the UI bridge rule).
  $effect(() => {
    const off = session.addSampleListener((sample) => {
      drawNormalizedStripBars(
        barsCanvas,
        normalizeEnergies(sample.energies, sample.stripPixelCounts),
        session.tunables.triggerLevel,
      )
    })
    return off
  })

  function numberValue(event: Event): number {
    return Number((event.currentTarget as HTMLInputElement).value)
  }

  // Trigger suggestion (the shared lab/fly flow): observe quietWindowMs of
  // samples on a quiet scene, then offer the collector's suggestion. The
  // session prop never changes after mount (created once per screen), so
  // capturing it at init is deliberate.
  // svelte-ignore state_referenced_locally
  const trigger = createTriggerCollection(session)
</script>

<AppBar
  title="Calibrate"
  subtitle={session.course.name}
  backHref={hashFor({ id: 'course', courseId: session.course.id })}
/>

<div class="controls camrow">
  <button
    class="btn btn-primary"
    onclick={() => void session.startCapture()}
    disabled={session.captureRunning || cameraState.status === 'requesting'}
  >
    Start camera
  </button>
  <button
    class="btn btn-ghost"
    onclick={() => session.stopCapture()}
    disabled={!session.captureRunning}
  >
    Stop camera
  </button>
</div>
{#if session.captureRunning}
  <WakeLockWarning wakeLockState={session.wakeLockState} />
{/if}

{#if session.captureError !== null}
  <p class="notice-error">{session.captureError}</p>
{/if}
{#if cameraState.status === 'denied' || cameraState.status === 'blocked' || cameraState.status === 'unavailable'}
  <p class="notice-error">
    camera {cameraState.status} ({cameraState.error.kind}): {cameraState.error.message} — see
    <a href="#/diag">diagnostics</a> for recovery steps.
  </p>
{/if}
{#if session.audioError !== null}
  <p class="notice-error">
    audio priming failed: {session.audioError}
    <button onclick={() => void session.primeAudio()}>Retry</button>
  </p>
{/if}

{#if cameraState.status === 'idle'}
  <p class="hint">
    Prop the phone beside the gate, then start the camera. Starting also unlocks the beeps and
    spoken lap times.
  </p>
{/if}

{#if cameraState.status === 'active'}
  <div class="preview">
    <video bind:this={videoEl} muted playsinline autoplay></video>
    <Chip variant="ok" class="dirchip">
      {#snippet icon()}
        {#if session.course.direction === 'ltr'}
          <svg class="ic-sm" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
        {:else}
          <svg class="ic-sm" viewBox="0 0 24 24"><path d="M19 12H5M11 6l-6 6 6 6" /></svg>
        {/if}
      {/snippet}
      {session.course.direction === 'ltr' ? 'L → R' : 'R → L'}
    </Chip>
    <RoiOverlay {session} />
  </div>
  <p class="hint drag-hint">Drag the rectangle over the gate; drag a corner to resize.</p>
{/if}

<MeterFrame
  stripCount={session.tunables.stripCount}
  triggerLevel={session.tunables.triggerLevel}
>
  <canvas class="bars" bind:this={barsCanvas} width="360" height="72"></canvas>
</MeterFrame>

<!-- Direction and min lap time belong to the course (product.md): shown
     read-only here, edited via the course form. -->
<p class="course-line hint mono">
  {directionLabel(session.course.direction)} · min lap {formatMinLap(session.course.minLapTimeMs)}
  <a href={hashFor({ id: 'edit-course', courseId: session.course.id })}>Edit course</a>
</p>

<div class="field sens">
  <div class="labelrow">
    <span class="label">Sensitivity</span>
    <span class="mono readout">
      trigger {fmtNumber(session.tunables.triggerLevel, 2)}{triggerAuto ? ' · auto' : ''}
    </span>
  </div>
  <input
    class="slider-native"
    type="range"
    min="0.01"
    max="1"
    step="0.01"
    value={session.tunables.triggerLevel}
    aria-label="Sensitivity (trigger level)"
    oninput={(e) => {
      triggerAuto = false
      session.updateTunables({ triggerLevel: numberValue(e) })
    }}
  />
</div>

<div class="controls">
  <button onclick={() => trigger.start()} disabled={trigger.collecting || !session.captureRunning}>
    Suggest trigger
  </button>
  {#if trigger.collecting}
    <span class="hint">
      observing quiet scene… {(trigger.observedMs / 1000).toFixed(1)} / {(
        trigger.quietWindowMs / 1000
      ).toFixed(0)} s
    </span>
  {/if}
  {#if trigger.aborted}
    <span class="hint">suggestion aborted — settings changed</span>
  {/if}
  {#if trigger.suggestion !== null}
    <span class="hint">suggested: <code>{fmtNumber(trigger.suggestion, 3)}</code></span>
    <button
      onclick={() => {
        trigger.apply()
        triggerAuto = true
      }}
    >
      Apply
    </button>
  {/if}
</div>

<!-- BEHAVIOR: prefilled from the course's most recent session's note
     (product.md setup step); arm() seeds the new session with it. -->
<label class="field">
  <span class="label">Session note</span>
  <input
    class="val note-input"
    type="text"
    placeholder="e.g. new props, windy day"
    value={session.note}
    oninput={(e) => session.setNote((e.currentTarget as HTMLInputElement).value)}
  />
</label>

<label class="speech-toggle">
  <input
    type="checkbox"
    checked={speechEnabled}
    onchange={(e) => onSpeechEnabledChange((e.currentTarget as HTMLInputElement).checked)}
  />
  <span>spoken lap times</span>
</label>

<div class="actions">
  <!-- Test mode stays available read-only (it records nothing), but not
       during an orientation mismatch — detection itself is invalid then. -->
  <button
    class="btn btn-ghost"
    onclick={() => session.startTestMode()}
    disabled={!session.captureRunning || session.orientationMismatch}
  >
    <svg class="ic" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
    Test mode
  </button>
  <button class="btn btn-warm" onclick={arm} disabled={!session.captureRunning || armDisabled}>
    <svg class="ic" viewBox="0 0 24 24"><path d="M12 2v9M7.5 5.5a7 7 0 1 0 9 0" /></svg>
    ARM
  </button>
</div>

<style>
  /* Phone-viewport budget (mockup 04 is one 390×844 screen): margins here are
     deliberately tight so preview + meter + sensitivity stay above the fold;
     the note and Test mode/ARM may scroll on small phones. */
  .camrow {
    margin: 0.4rem 0;
  }

  .camrow button {
    width: auto;
    flex: 1;
    padding: 10px 12px;
  }

  .preview {
    position: relative;
    width: 100%;
    max-width: 26rem;
    margin: 0.4rem 0 0;
    border: 1px solid var(--c-line);
    border-radius: 14px;
    overflow: hidden;
    background: #000;
  }

  .preview video {
    width: 100%;
    display: block;
  }

  /* Chip class passthrough (positioning only); pointer-events off so ROI
     drags near the corner pass through to the overlay beneath. */
  .preview :global(.dirchip) {
    position: absolute;
    left: 10px;
    top: 10px;
    z-index: 3;
    pointer-events: none;
  }

  .bars {
    display: block;
    width: 100%;
    height: auto;
  }

  .drag-hint {
    margin: 0.4rem 0 0.6rem;
  }

  .course-line {
    display: flex;
    flex-wrap: wrap;
    gap: 0.6rem;
    align-items: baseline;
    margin: 0.6rem 0 0.2rem;
  }

  .sens {
    margin: 0.4rem 0;
  }

  .labelrow {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
  }

  .readout {
    font-size: 0.72rem;
    color: var(--c-record);
  }

  .note-input {
    color: var(--c-signal);
    font-style: italic;
    font-size: 0.9rem;
    padding: 11px 13px;
  }

  .note-input::placeholder {
    color: var(--c-dim2);
    font-style: italic;
  }

  .speech-toggle {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0.6rem 0;
    font-size: 0.9rem;
  }

  .speech-toggle input {
    accent-color: var(--c-signal);
    width: 18px;
    height: 18px;
  }

  code {
    text-align: right;
  }

  .actions {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-top: 0.75rem;
  }
</style>
