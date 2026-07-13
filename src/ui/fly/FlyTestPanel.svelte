<script lang="ts">
  import { drawNormalizedStripBars } from '../shared/energy-bars'
  import { normalizeEnergies } from '../shared/energy-math'
  import WakeLockWarning from '../shared/WakeLockWarning.svelte'
  import type { FlySession } from './fly-session'

  let { session }: { session: FlySession } = $props()

  let barsCanvas: HTMLCanvasElement | null = null

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
</script>

<WakeLockWarning wakeLockState={session.wakeLockState} />

<p class="hint">
  Test mode records nothing — every crossing in the course direction beeps. Wave a hand or fly
  through the gate to verify the setup.
</p>

<div class="count" aria-live="polite">
  <span class="count-value">{session.testCrossingCount}</span>
  <span class="count-label">crossings detected</span>
</div>

<canvas class="bars" bind:this={barsCanvas} width="360" height="72"></canvas>

<div class="controls actions">
  <button onclick={() => session.stopTestMode()}>Back to setup</button>
  <button class="primary" onclick={() => session.arm()} disabled={!session.captureRunning}>
    Arm
  </button>
</div>

<style>
  .count {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    margin: 1rem 0;
  }

  .count-value {
    font-size: 3.5rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    line-height: 1;
  }

  .count-label {
    opacity: 0.7;
  }

  .bars {
    display: block;
    margin: 0.5rem 0;
    border: 1px solid #2c3850;
    border-radius: 0.375rem;
    max-width: 100%;
  }

  .actions button {
    padding: 0.7rem 1.6rem;
    font-size: 1.05rem;
  }
</style>
