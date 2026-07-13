<script lang="ts">
  import type { CameraSourceStats } from '../../core/detection/camera-source'
  import type { LatencyStats } from '../../core/stats/latency-stats'
  import Verdict from '../diag/Verdict.svelte'
  import { fmtFps, fmtMs } from '../diag/format'
  import type { CaptureSession } from '../shared/capture-session'
  import { drawNormalizedStripBars } from '../shared/energy-bars'
  import { normalizeEnergies } from '../shared/energy-math'
  import { PipelineCostTracker } from './pipeline-cost'
  import RoiOverlay from '../shared/RoiOverlay.svelte'

  let { session }: { session: CaptureSession } = $props()

  let videoEl = $state<HTMLVideoElement | null>(null)
  let barsCanvas: HTMLCanvasElement | null = null

  const tracker = new PipelineCostTracker()

  // 1 Hz snapshots for everything that isn't per-frame; the per-frame
  // readout (frames seen, rolling rate) renders onto the bars canvas from
  // the sample listener — the UI bridge rule, no reactive state involved.
  let costStats = $state<LatencyStats | null>(null)
  let sourceStats = $state<CameraSourceStats | null>(null)
  let snapshotFps = $state<number | null>(null)

  $effect(() => {
    const offFrame = session.addFrameListener(() => tracker.markFrameStart(performance.now()))
    const offSample = session.addSampleListener((sample) => {
      const now = performance.now()
      tracker.markSampleDone(now)
      drawNormalizedStripBars(
        barsCanvas,
        normalizeEnergies(sample.energies, sample.stripPixelCounts),
        session.tunables.triggerLevel,
        `${tracker.frames} frames · ${fmtFps(tracker.rollingFps(now))}`,
      )
    })
    const pollTimer = setInterval(() => {
      costStats = tracker.costStats() ?? null
      sourceStats = session.cameraStats()
      snapshotFps = tracker.rollingFps(performance.now())
    }, 1000)
    return () => {
      offFrame()
      offSample()
      clearInterval(pollTimer)
    }
  })

  $effect(() => {
    if (videoEl !== null && session.cameraState.status === 'active') {
      videoEl.srcObject = session.cameraState.stream
    }
  })

  async function start() {
    tracker.reset()
    costStats = null
    sourceStats = null
    snapshotFps = null
    await session.startCapture()
  }

  const cameraState = $derived(session.cameraState)
  const grantedFps = $derived(
    cameraState.status === 'active' ? (cameraState.granted.frameRate ?? null) : null,
  )
  // Budget per ADR 0008: the whole per-frame cost must fit in half a frame
  // interval; the measured delivered rate wins over the granted one.
  const budgetFps = $derived(snapshotFps ?? grantedFps ?? 60)
  const budgetMs = $derived(1000 / budgetFps / 2)
  const budgetOk = $derived(
    costStats !== null && costStats.medianMs <= budgetMs && costStats.p95Ms <= budgetMs,
  )

  function fmtRect(rect: CameraSourceStats['cropRect']): string {
    if (!rect) return '—'
    return `${rect.width}×${rect.height} @ (${rect.x}, ${rect.y})`
  }
</script>

<div class="controls">
  <button
    onclick={() => void start()}
    disabled={session.captureRunning || cameraState.status === 'requesting'}
  >
    Start camera + pipeline
  </button>
  <button onclick={() => session.stopCapture()} disabled={!session.captureRunning}>Stop</button>
  <span class="state">camera: <code>{cameraState.status}</code></span>
  <span class="state">
    wake lock:
    <Verdict
      verdict={session.wakeLockState === 'active'
        ? 'pass'
        : session.wakeLockState === 'failed' || session.wakeLockState === 'unsupported'
          ? 'fail'
          : 'na'}
      label={session.wakeLockState.toUpperCase()}
    />
  </span>
</div>

{#if session.captureError !== null}
  <p class="error">{session.captureError}</p>
{/if}
{#if cameraState.status === 'denied' || cameraState.status === 'blocked' || cameraState.status === 'unavailable'}
  <p class="error">
    camera {cameraState.status} ({cameraState.error.kind}): {cameraState.error.message}
    — see /diag for recovery steps.
  </p>
{/if}
{#if cameraState.status === 'idle'}
  <p class="hint">
    Start the camera to run the live pipeline: preview + draggable ROI, per-strip energy bars
    against the trigger line, and the per-frame cost readout.
  </p>
{/if}

{#if cameraState.status === 'active'}
  <div class="preview-wrap">
    <video bind:this={videoEl} muted playsinline autoplay class="preview"></video>
    <RoiOverlay {session} />
  </div>
  <p class="hint">Drag inside the rectangle to move the ROI, drag a corner to resize.</p>
{/if}

<canvas class="bars" bind:this={barsCanvas} width="360" height="80"></canvas>

{#if sourceStats !== null}
  <dl class="kv">
    <dt>format</dt>
    <dd>{sourceStats.format ?? '—'} ({sourceStats.codedWidth}×{sourceStats.codedHeight})</dd>
    <dt>crop rect</dt>
    <dd>{fmtRect(sourceStats.cropRect)}</dd>
    <dt>rect copy</dt>
    <dd>
      <Verdict
        verdict={sourceStats.usedRectCopy ? 'pass' : 'warn'}
        label={sourceStats.usedRectCopy ? 'ROI-CROPPED' : 'FULL-FRAME FALLBACK'}
      />
    </dd>
    <dt>read / emitted / errors</dt>
    <dd>{sourceStats.frames} / {sourceStats.emitted} / {sourceStats.errors}</dd>
  </dl>
  {#if sourceStats.lastError !== undefined}
    <p class="error">last source error: {sourceStats.lastError}</p>
  {/if}
{/if}

{#if costStats !== null}
  <div class="table-scroll">
    <table>
      <thead>
        <tr>
          <th>Pipeline cost (tee→sample)</th>
          <th>Samples</th>
          <th>Median</th>
          <th>p95</th>
          <th>Max</th>
          <th>Gate (≤ {fmtMs(budgetMs)} = ½ interval @ {fmtFps(budgetFps)})</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>reduce + fan-out</td>
          <td class="num">{costStats.count}</td>
          <td class="num">{fmtMs(costStats.medianMs)}</td>
          <td class="num">{fmtMs(costStats.p95Ms)}</td>
          <td class="num">{fmtMs(costStats.maxMs)}</td>
          <td><Verdict verdict={budgetOk ? 'pass' : 'fail'} /></td>
        </tr>
      </tbody>
    </table>
  </div>
  <p class="hint">
    Excludes CameraSource's copyTo/subsample stage (the /diag WebCodecs probe measures that half);
    the ADR 0009 re-measurement reads this gate together with the rect-copy flag and the delivered
    rate above.
  </p>
{/if}

<style>
  .preview-wrap {
    position: relative;
    width: 100%;
    max-width: 24rem;
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

  .state {
    font-size: 0.85rem;
    opacity: 0.9;
  }
</style>
