<script lang="ts">
  import { ASSUMED_FPS, frameIntervalForFps, latencyVerdict } from '../../core/diag/verdicts'
  import { FrameLoop } from '../../core/frame-loop/frame-loop'
  import { centeredRoi, FULL_FRAME_ROI } from '../../core/gpu/luminance-pass'
  import {
    ReadbackHarness,
    videoElementSource,
    type ImportPath,
    type ReadbackSnapshot,
  } from '../../core/gpu/readback-benchmark'
  import type { LatencyStats } from '../../core/gpu/readback-stats'
  import type { DiagSession } from './diag-session'
  import Verdict from './Verdict.svelte'
  import { errorText, fmtClock, fmtFps, fmtMs, fmtNumber } from './format'

  let { session }: { session: DiagSession } = $props()

  const SUSTAIN_MS = 5 * 60 * 1000
  // ADR 0008 wants both a full-frame run (crude pass may dominate) and a
  // small-ROI run (minimal pass cost) so pass-cost vs readback-path-cost can
  // be attributed. The small ROI is centered in the frame — same latency as
  // origin, but it samples where a gate would actually sit.
  const SMALL_ROI_SIZE = 64

  let path = $state<ImportPath>('external')
  let roiChoice = $state<'full' | 'small'>('full')
  // ADR 0008's half-rate disambiguation run: the harness processes every 2nd
  // frame-loop tick, halving GPU/readback work while rVFC delivery is
  // untouched.
  let rateChoice = $state<'full' | 'half'>('full')
  let running = $state(false)
  let sustainMode = $state(false)
  let sustainDone = $state(false)
  let elapsedMs = $state(0)
  let snapshot = $state<ReadbackSnapshot | null>(null)
  // Which ROI produced the displayed snapshot, so a transcribed run can't be
  // mistaken for the other ADR 0008 slot.
  let snapshotRoiLabel = $state<string | null>(null)
  let startFailure = $state<string | null>(null)
  // Set only by the identity-guard auto-stop, so a sustain aborted mid-run is
  // distinguishable from a manual Stop; cleared on the next start.
  let autoStopNotice = $state<string | null>(null)
  // What this run started against. The auto-stop guard compares identity, not
  // just null: a GPU re-acquire swaps session.device old→new without passing
  // through null, and the harness must not keep submitting to the destroyed
  // device it captured at construction.
  let startedVideo = $state.raw<HTMLVideoElement | null>(null)
  let startedDevice = $state.raw<GPUDevice | null>(null)

  let harness: ReadbackHarness | null = null
  let loop: FrameLoop | null = null
  let pollTimer: ReturnType<typeof setInterval> | undefined
  let startedAtMs = 0

  const ready = $derived(session.video !== null && session.device !== null)
  // Latency verdicts compare against the frame interval derived from the
  // frame-loop panel's measured fps; before that panel has run, 60 fps
  // (16.67 ms) is assumed and labeled as such.
  const frameIntervalMs = $derived(frameIntervalForFps(session.measuredFps))
  const frameIntervalAssumed = $derived(session.measuredFps === null)
  const gateFps = $derived(session.measuredFps ?? ASSUMED_FPS)
  // The gate's fps was measured before this run; the run's own tick rate
  // (scaled back up by the decimation factor) is the camera rate NOW. A >20%
  // divergence means the gate may be judging against the wrong frame interval
  // (e.g. thermal drop, or fps never re-measured after a camera change).
  const effectiveTickRate = $derived(
    snapshot !== null && snapshot.rollingTicksPerSecond !== undefined
      ? snapshot.rollingTicksPerSecond * snapshot.tickDecimation
      : undefined,
  )
  const gateFpsDiverges = $derived(
    effectiveTickRate !== undefined && Math.abs(effectiveTickRate - gateFps) / gateFps > 0.2,
  )

  function start(sustain: boolean) {
    const video = session.video
    const device = session.device
    if (video === null || device === null || running) return
    startFailure = null
    autoStopNotice = null
    snapshot = null
    sustainDone = false
    const roi =
      roiChoice === 'full'
        ? FULL_FRAME_ROI
        : centeredRoi(video.videoWidth, video.videoHeight, SMALL_ROI_SIZE)
    try {
      harness = new ReadbackHarness(device, videoElementSource(video), {
        path,
        roi,
        tickDecimation: rateChoice === 'half' ? 2 : 1,
      })
      loop = new FrameLoop(video, (sample) => harness?.onFrame(sample))
      loop.start()
    } catch (error) {
      startFailure = errorText(error)
      harness?.destroy()
      harness = null
      loop = null
      return
    }
    snapshotRoiLabel =
      roiChoice === 'full'
        ? 'full frame'
        : `${SMALL_ROI_SIZE}×${SMALL_ROI_SIZE} @ (${roi.x}, ${roi.y})`
    startedVideo = video
    startedDevice = device
    running = true
    sustainMode = sustain
    startedAtMs = performance.now()
    elapsedMs = 0
    pollTimer = setInterval(() => {
      elapsedMs = performance.now() - startedAtMs
      if (harness !== null) snapshot = harness.snapshot()
      if (sustainMode && elapsedMs >= SUSTAIN_MS) {
        sustainDone = true
        stop()
      }
    }, 1000)
  }

  function stop() {
    loop?.stop()
    loop = null
    clearInterval(pollTimer)
    pollTimer = undefined
    if (harness !== null) {
      snapshot = harness.snapshot()
      harness.destroy()
      harness = null
    }
    running = false
    sustainMode = false
    startedVideo = null
    startedDevice = null
  }

  $effect(() => {
    if (running && (session.video !== startedVideo || session.device !== startedDevice)) {
      stop()
      autoStopNotice = 'Stopped automatically: the GPU device or camera changed mid-run.'
    }
  })

  $effect(() => () => stop())

  const latencyRows = $derived<[string, LatencyStats | undefined][]>(
    snapshot === null
      ? []
      : [
          ['overall', snapshot.overall],
          ['rolling', snapshot.rolling],
        ],
  )
</script>

<div class="controls">
  <label>
    path
    <select bind:value={path} disabled={running}>
      <option value="external">external (importExternalTexture)</option>
      <option value="copy">copy (copyExternalImageToTexture)</option>
    </select>
  </label>
  <label>
    ROI
    <select bind:value={roiChoice} disabled={running}>
      <option value="full">Full frame</option>
      <option value="small">Small ROI (64×64)</option>
    </select>
  </label>
  <label>
    rate
    <select bind:value={rateChoice} disabled={running}>
      <option value="full">Full rate (every tick)</option>
      <option value="half">Half rate (every 2nd tick)</option>
    </select>
  </label>
  <button onclick={() => start(false)} disabled={!ready || running}>Start</button>
  <button onclick={() => start(true)} disabled={!ready || running}>5-minute sustain</button>
  <button onclick={stop} disabled={!running}>Stop</button>
  {#if running}
    <span class="elapsed">
      {fmtClock(elapsedMs)}{sustainMode ? ` / ${fmtClock(SUSTAIN_MS)} sustain` : ''}
    </span>
  {:else if sustainDone}
    <Verdict verdict="pass" label="SUSTAIN COMPLETE" />
  {/if}
</div>

{#if !ready}
  <p class="hint">Needs the camera running and a GPU device acquired.</p>
{/if}

{#if startFailure !== null}
  <p class="error">Benchmark failed to start: {startFailure}</p>
{/if}

{#if autoStopNotice !== null}
  <p class="error">{autoStopNotice}</p>
{/if}

{#if snapshot !== null}
  <dl class="kv">
    <dt>path</dt>
    <dd>{snapshot.path}</dd>
    <dt>ROI</dt>
    <dd>{snapshotRoiLabel}</dd>
    <dt>ticks</dt>
    <dd>{snapshot.ticks}</dd>
    <dt>rolling tick rate</dt>
    <dd>
      {fmtFps(snapshot.rollingTicksPerSecond)}{snapshot.tickDecimation > 1
        ? ` (processed ticks at 1/${snapshot.tickDecimation} camera rate)`
        : ''}
    </dd>
    <dt>completed</dt>
    <dd>{snapshot.completed} ({fmtNumber(snapshot.completedPerSecond, 1)}/s)</dd>
    <dt>overruns</dt>
    <dd>{snapshot.overruns}</dd>
    <dt>skipped (no frame)</dt>
    <dd>{snapshot.skippedNoFrame}</dd>
    <dt>errors</dt>
    <dd>{snapshot.errors}</dd>
    <dt>last luminance</dt>
    <dd>{fmtNumber(snapshot.lastValue, 4)}</dd>
  </dl>
  {#if snapshot.lastError !== undefined}
    <p class="error">last error: {snapshot.lastError}</p>
  {/if}
  <div class="table-scroll">
    <table>
      <thead>
        <tr>
          <th>Latency</th>
          <th>Samples</th>
          <th>Mean</th>
          <th>Median</th>
          <th>p95</th>
          <th>Max</th>
          <th>
            Gate (median &amp; p95 ≤ {fmtMs(frameIntervalMs)}, {frameIntervalAssumed
              ? `assumed ${ASSUMED_FPS} fps`
              : `measured ${fmtFps(gateFps)}`})
          </th>
        </tr>
      </thead>
      <tbody>
        {#each latencyRows as [label, stats] (label)}
          <tr>
            <td>{label}</td>
            <td class="num">{stats?.count ?? '—'}</td>
            <td class="num">{fmtMs(stats?.meanMs)}</td>
            <td class="num">{fmtMs(stats?.medianMs)}</td>
            <td class="num">{fmtMs(stats?.p95Ms)}</td>
            <td class="num">{fmtMs(stats?.maxMs)}</td>
            <td><Verdict verdict={latencyVerdict(stats, frameIntervalMs)} /></td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  {#if gateFpsDiverges}
    <p class="hint">
      The latency gate's fps ({fmtFps(gateFps)}) differs from this run's tick rate ({fmtFps(
        effectiveTickRate,
      )}) by more than 20% — the gate may be judging against the wrong frame interval. Re-measure
      fps in the frame-loop panel, or read the verdict against the tick rate.
    </p>
  {/if}
  <dl class="kv">
    <dt>drift</dt>
    <dd>
      {#if snapshot.drift !== undefined}
        {fmtMs(snapshot.drift.driftMs)} ({fmtNumber(snapshot.drift.driftFraction * 100, 1)}% of early
        median {fmtMs(snapshot.drift.earlyMedianMs)} → late {fmtMs(snapshot.drift.lateMedianMs)})
        <Verdict
          verdict={snapshot.drift.upwardDrift ? 'fail' : 'pass'}
          label={snapshot.drift.upwardDrift ? 'UPWARD DRIFT' : 'NO DRIFT'}
        />
      {:else}
        needs ≥ 2×600 completed readbacks (~20 s at 60 fps)
      {/if}
    </dd>
  </dl>
{/if}

<style>
  label {
    font-size: 0.85rem;
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }

  select {
    background: #16233c;
    color: #e8edf7;
    border: 1px solid #2c3850;
    border-radius: 0.375rem;
    padding: 0.3rem 0.4rem;
  }

  .elapsed {
    font-family: monospace;
    font-size: 0.9rem;
  }
</style>
