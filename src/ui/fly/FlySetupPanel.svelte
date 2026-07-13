<script lang="ts">
  import type { CrossingDirection } from '../../core/detection/crossing-events'
  import { fmtNumber } from '../diag/format'
  import { drawNormalizedStripBars } from '../shared/energy-bars'
  import { normalizeEnergies } from '../shared/energy-math'
  import RoiOverlay from '../shared/RoiOverlay.svelte'
  import { createTriggerCollection } from '../shared/trigger-collection.svelte'
  import WakeLockWarning from '../shared/WakeLockWarning.svelte'
  import type { FlySession } from './fly-session'

  let { session }: { session: FlySession } = $props()

  let videoEl = $state<HTMLVideoElement | null>(null)
  let barsCanvas: HTMLCanvasElement | null = null

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

  const minLapSeconds = $derived(session.minLapTimeMs / 1000)

  function onMinLapChange(event: Event): void {
    const input = event.currentTarget as HTMLInputElement
    // A cleared field reads '' and Number('') is 0, which would silently
    // disable the debounce — ignore empty/invalid input and keep the prior
    // value instead.
    const seconds = input.value.trim() === '' ? Number.NaN : Number(input.value)
    if (Number.isFinite(seconds) && seconds >= 0) {
      session.setMinLapTimeMs(Math.round(seconds * 1000))
    }
    // Re-render the effective value: when the input was rejected the reactive
    // value did not change, so Svelte would leave the stale text in place.
    input.value = String(session.minLapTimeMs / 1000)
  }

  // Trigger suggestion (the shared lab/fly flow): observe quietWindowMs of
  // samples on a quiet scene, then offer the collector's suggestion. The
  // session prop never changes after mount (created once per screen), so
  // capturing it at init is deliberate.
  // svelte-ignore state_referenced_locally
  const trigger = createTriggerCollection(session)
</script>

<div class="controls">
  <button
    class="primary"
    onclick={() => void session.startCapture()}
    disabled={session.captureRunning || cameraState.status === 'requesting'}
  >
    Start camera
  </button>
  <button onclick={() => session.stopCapture()} disabled={!session.captureRunning}>
    Stop camera
  </button>
  {#if session.captureRunning}
    <WakeLockWarning wakeLockState={session.wakeLockState} />
  {/if}
</div>

{#if session.captureError !== null}
  <p class="error">{session.captureError}</p>
{/if}
{#if cameraState.status === 'denied' || cameraState.status === 'blocked' || cameraState.status === 'unavailable'}
  <p class="error">
    camera {cameraState.status} ({cameraState.error.kind}): {cameraState.error.message} — see
    <a href="#/diag">diagnostics</a> for recovery steps.
  </p>
{/if}
{#if session.audioError !== null}
  <p class="error">
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
  <div class="preview-wrap">
    <video bind:this={videoEl} muted playsinline autoplay class="preview"></video>
    <RoiOverlay {session} />
  </div>
  <p class="hint">Drag the rectangle over the gate; drag a corner to resize.</p>
{/if}

<canvas class="bars" bind:this={barsCanvas} width="360" height="72"></canvas>

<div class="fields">
  <label>
    <span>direction</span>
    <select
      value={session.direction}
      onchange={(e) =>
        session.setDirection((e.currentTarget as HTMLSelectElement).value as CrossingDirection)}
    >
      <option value="ltr">left → right</option>
      <option value="rtl">right → left</option>
    </select>
  </label>
  <label>
    <span>min lap time (s)</span>
    <input type="number" min="0" step="0.5" value={minLapSeconds} onchange={onMinLapChange} />
  </label>
  <label>
    <span>trigger level</span>
    <input
      type="range"
      min="0.01"
      max="1"
      step="0.01"
      value={session.tunables.triggerLevel}
      oninput={(e) => session.updateTunables({ triggerLevel: numberValue(e) })}
    />
    <code>{fmtNumber(session.tunables.triggerLevel, 2)}</code>
  </label>
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
    <button onclick={() => trigger.apply()}>Apply</button>
  {/if}
</div>

<div class="controls actions">
  <button onclick={() => session.startTestMode()} disabled={!session.captureRunning}>
    Test mode
  </button>
  <button class="primary" onclick={() => session.arm()} disabled={!session.captureRunning}>
    Arm
  </button>
</div>

<style>
  .preview-wrap {
    position: relative;
    width: 100%;
    max-width: 26rem;
    margin: 0.5rem 0;
  }

  .preview {
    width: 100%;
    display: block;
    border-radius: 0.375rem;
    background: #000;
  }

  .bars {
    display: block;
    margin: 0.5rem 0;
    border: 1px solid #2c3850;
    border-radius: 0.375rem;
    max-width: 100%;
  }

  .fields {
    display: grid;
    gap: 0.5rem;
    margin: 0.75rem 0;
  }

  label {
    display: grid;
    grid-template-columns: 8.5rem 1fr 3.5rem;
    align-items: center;
    gap: 0.6rem;
    font-size: 0.9rem;
  }

  label select,
  label input[type='number'] {
    grid-column: 2 / 4;
    background: #16233c;
    color: #e8edf7;
    border: 1px solid #2c3850;
    border-radius: 0.375rem;
    padding: 0.35rem 0.5rem;
    font-size: 0.95rem;
  }

  label input[type='range'] {
    width: 100%;
  }

  code {
    text-align: right;
  }

  .actions {
    margin-top: 1rem;
  }

  .actions button {
    padding: 0.7rem 1.6rem;
    font-size: 1.05rem;
  }
</style>
