<script lang="ts">
  import AppBar from '../shared/AppBar.svelte'
  import MeterFrame from '../shared/MeterFrame.svelte'
  import Toast from '../shared/Toast.svelte'
  import { drawNormalizedStripBars } from '../shared/energy-bars'
  import { normalizeEnergies } from '../shared/energy-math'
  import WakeLockWarning from '../shared/WakeLockWarning.svelte'
  import type { FlySession } from './fly-session'

  let {
    session,
    arm,
    armDisabled,
  }: {
    session: FlySession
    // FlyFlow's guarded arm + its disable reason rendering; test mode itself
    // stays available read-only (it records nothing).
    arm: () => void
    armDisabled: boolean
  } = $props()

  let videoEl = $state<HTMLVideoElement | null>(null)
  let barsCanvas: HTMLCanvasElement | null = null

  const cameraState = $derived(session.cameraState)
  const roi = $derived(session.tunables.roi)

  $effect(() => {
    if (videoEl !== null && cameraState.status === 'active') {
      videoEl.srcObject = cameraState.stream
    }
  })

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

  // Transient crossing feedback (mockup 05): each detected crossing raises
  // the cyan toast + screen-edge flash for ~1.2 s (the beep fires in the
  // session). Reactive off the crossing count; a new crossing restarts the
  // window.
  let crossingFlash = $state(false)
  $effect(() => {
    if (session.testCrossingCount === 0) return
    crossingFlash = true
    const timer = setTimeout(() => {
      crossingFlash = false
    }, 1200)
    return () => clearTimeout(timer)
  })
</script>

<!-- Full-height column so ARM rides the viewport bottom (mockup 05's
     margin-top:auto composition). -->
<div class="test-screen">
<AppBar
  title="Test mode"
  subtitle="Records nothing"
  subtitleTone="dim"
  onback={() => session.stopTestMode()}
/>

{#if crossingFlash}
  <div class="flashborder" aria-hidden="true"></div>
{/if}

<WakeLockWarning wakeLockState={session.wakeLockState} />

{#if cameraState.status === 'active'}
  <div class="preview">
    <video bind:this={videoEl} muted playsinline autoplay></video>
    <span class="rec-dot"><span class="d"></span>LIVE</span>
    <!-- ROI shown for orientation only — editing belongs to setup. -->
    <div
      class="roi-ghost"
      aria-hidden="true"
      style:left={`${roi.x * 100}%`}
      style:top={`${roi.y * 100}%`}
      style:width={`${roi.width * 100}%`}
      style:height={`${roi.height * 100}%`}
    ></div>
    {#if crossingFlash}
      <Toast>
        {#snippet icon()}
          <svg class="ic-sm" viewBox="0 0 24 24"><path d="M5 12l5 5L20 7" /></svg>
        {/snippet}
        Crossing · {session.course.direction === 'ltr' ? 'L → R' : 'R → L'}
      </Toast>
    {/if}
  </div>
{/if}

<MeterFrame stripCount={session.tunables.stripCount} triggerLevel={session.tunables.triggerLevel}>
  {#snippet status()}
    <span aria-live="polite">{session.testCrossingCount} crossings detected</span>
  {/snippet}
  <canvas class="bars" bind:this={barsCanvas} width="360" height="72"></canvas>
</MeterFrame>

<p class="hint helper">
  Test mode records nothing — every crossing in the course direction beeps. Wave a hand or fly
  through the gate to verify the setup.
</p>

<button class="btn btn-warm arm-big" onclick={arm} disabled={!session.captureRunning || armDisabled}>
  <svg class="ic arm-ic" viewBox="0 0 24 24"><path d="M12 2v9M7.5 5.5a7 7 0 1 0 9 0" /></svg>
  ARM
</button>
</div>

<style>
  .test-screen {
    display: flex;
    flex-direction: column;
    min-height: calc(100dvh - 3rem);
  }

  .preview {
    position: relative;
    width: 100%;
    max-width: 26rem;
    margin: 0.5rem 0;
    border: 1px solid var(--c-line);
    border-radius: 14px;
    overflow: hidden;
    background: #000;
  }

  .preview video {
    width: 100%;
    display: block;
  }

  .rec-dot {
    position: absolute;
    right: 12px;
    top: 11px;
    z-index: 3;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-mono);
    font-size: 0.62rem;
    letter-spacing: 0.12em;
    color: var(--c-signal);
  }

  .rec-dot .d {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--c-signal);
  }

  .roi-ghost {
    position: absolute;
    border: 1.5px dashed var(--c-signal);
    border-radius: 4px;
    background: rgba(51, 222, 207, 0.05);
    pointer-events: none;
  }

  .bars {
    display: block;
    width: 100%;
    height: auto;
  }

  .helper {
    text-align: center;
    margin: 0.5rem 0 1rem;
    line-height: 1.45;
  }

  .arm-big {
    margin-top: auto;
    padding: 22px;
    font-size: 1.35rem;
    letter-spacing: 0.08em;
  }

  .arm-ic {
    width: 22px;
    height: 22px;
  }
</style>
