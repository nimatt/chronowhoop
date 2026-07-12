<script lang="ts">
  import {
    isWebCodecsCaptureSupported,
    WebCodecsPipelineProbe,
    type WebCodecsProbeSnapshot,
  } from '../../core/cpu-pipeline/webcodecs-probe'
  import { DEFAULT_STRIP_REDUCE_CONFIG } from '../../core/cpu-pipeline/strip-reduce'
  import {
    ASSUMED_FPS,
    frameIntervalForFps,
    jitterVerdict,
    latencyVerdict,
  } from '../../core/diag/verdicts'
  import type { LatencyStats } from '../../core/gpu/readback-stats'
  import type { DiagSession } from './diag-session'
  import { drawStripBars } from './strip-bars'
  import Verdict from './Verdict.svelte'
  import { errorText, fmtClock, fmtFps, fmtMs, fmtNumber } from './format'

  let { session }: { session: DiagSession } = $props()

  const SUSTAIN_MS = 5 * 60 * 1000
  const supported = isWebCodecsCaptureSupported()

  let running = $state(false)
  let sustainMode = $state(false)
  let sustainDone = $state(false)
  let elapsedMs = $state(0)
  let snapshot = $state<WebCodecsProbeSnapshot | null>(null)
  let startFailure = $state<string | null>(null)
  let autoStopNotice = $state<string | null>(null)
  let startedTrack = $state.raw<MediaStreamTrack | null>(null)

  let probe: WebCodecsPipelineProbe | null = null
  let pollTimer: ReturnType<typeof setInterval> | undefined
  let startedAtMs = 0
  let barsCanvas: HTMLCanvasElement | null = null

  const track = $derived(
    session.cameraState.status === 'active'
      ? (session.cameraState.stream.getVideoTracks()[0] ?? null)
      : null,
  )
  const ready = $derived(supported && track !== null)
  const frameIntervalMs = $derived(frameIntervalForFps(session.measuredFps))
  const frameIntervalAssumed = $derived(session.measuredFps === null)
  const gateFps = $derived(session.measuredFps ?? ASSUMED_FPS)
  // Same declared CPU budget as the canvas probe (ADR 0008): the whole
  // per-frame cost must fit in half a frame interval at the granted rate.
  const cpuBudgetMs = $derived(frameIntervalMs / 2)

  function start(sustain: boolean) {
    if (track === null || running) return
    startFailure = null
    autoStopNotice = null
    snapshot = null
    sustainDone = false
    try {
      probe = new WebCodecsPipelineProbe(track, {
        onFrame: (energies, workingPixels) => drawStripBars(barsCanvas, energies, workingPixels),
      })
      probe.start()
    } catch (error) {
      startFailure = errorText(error)
      probe = null
      return
    }
    startedTrack = track
    running = true
    sustainMode = sustain
    startedAtMs = performance.now()
    elapsedMs = 0
    pollTimer = setInterval(() => {
      elapsedMs = performance.now() - startedAtMs
      if (probe !== null) snapshot = probe.snapshot()
      if (sustainMode && elapsedMs >= SUSTAIN_MS) {
        sustainDone = true
        stop()
      }
    }, 1000)
  }

  function stop() {
    clearInterval(pollTimer)
    pollTimer = undefined
    if (probe !== null) {
      snapshot = probe.snapshot()
      probe.stop()
      probe = null
    }
    running = false
    sustainMode = false
    startedTrack = null
  }

  $effect(() => {
    if (running && track !== startedTrack) {
      stop()
      autoStopNotice = 'Stopped automatically: the camera track changed mid-run.'
    }
  })

  $effect(() => () => stop())

  const stageRows = $derived<[string, LatencyStats | undefined, boolean][]>(
    snapshot === null
      ? []
      : [
          ['copyTo (frame → buffer)', snapshot.stages.copy, false],
          ['subsample + reduce', snapshot.stages.reduce, false],
          ['total (overall)', snapshot.stages.total, true],
          ['total (rolling)', snapshot.rollingTotal, true],
        ],
  )
</script>

<p class="hint">
  Canvas-free candidate: MediaStreamTrackProcessor delivers VideoFrames off the camera track; the Y
  plane is read directly (no RGBA conversion) and stride-subsampled into the same
  {DEFAULT_STRIP_REDUCE_CONFIG.stripCount}-strip reduction. Frame timestamps come from the frames
  themselves — their jitter row below doubles as a timestamp-source candidate.
</p>

{#if !supported}
  <p class="error">MediaStreamTrackProcessor is not available in this browser.</p>
{/if}

<div class="controls">
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

{#if supported && track === null}
  <p class="hint">Start the camera first — this probe reads its track directly.</p>
{/if}

{#if startFailure !== null}
  <p class="error">Probe failed to start: {startFailure}</p>
{/if}

{#if autoStopNotice !== null}
  <p class="error">{autoStopNotice}</p>
{/if}

<canvas class="bars" bind:this={barsCanvas} width="360" height="64"></canvas>

{#if snapshot !== null}
  <dl class="kv">
    <dt>frame format</dt>
    <dd>{snapshot.format ?? '—'} ({snapshot.codedWidth}×{snapshot.codedHeight})</dd>
    <dt>working resolution</dt>
    <dd>{snapshot.workingWidth}×{snapshot.workingHeight}</dd>
    <dt>processed</dt>
    <dd>{snapshot.processed} / {snapshot.frames} frames ({fmtNumber(snapshot.processedPerSecond, 1)}/s)</dd>
    <dt>rolling frame rate</dt>
    <dd>{fmtFps(snapshot.rollingFramesPerSecond)}</dd>
    <dt>errors</dt>
    <dd>{snapshot.errors}</dd>
  </dl>
  {#if snapshot.lastError !== undefined}
    <p class="error">last error: {snapshot.lastError}</p>
  {/if}
  <div class="table-scroll">
    <table>
      <thead>
        <tr>
          <th>Stage</th>
          <th>Samples</th>
          <th>Mean</th>
          <th>Median</th>
          <th>p95</th>
          <th>Max</th>
          <th>
            Gate (total: median &amp; p95 ≤ {fmtMs(cpuBudgetMs)} = ½ interval, {frameIntervalAssumed
              ? `assumed ${ASSUMED_FPS} fps`
              : `measured ${fmtFps(gateFps)}`})
          </th>
        </tr>
      </thead>
      <tbody>
        {#each stageRows as [label, stats, gated] (label)}
          <tr>
            <td>{label}</td>
            <td class="num">{stats?.count ?? '—'}</td>
            <td class="num">{fmtMs(stats?.meanMs)}</td>
            <td class="num">{fmtMs(stats?.medianMs)}</td>
            <td class="num">{fmtMs(stats?.p95Ms)}</td>
            <td class="num">{fmtMs(stats?.maxMs)}</td>
            <td>
              {#if gated}
                <Verdict verdict={latencyVerdict(stats, cpuBudgetMs)} />
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  <dl class="kv">
    <dt>frame timestamps</dt>
    <dd>
      median Δ {fmtMs(snapshot.frameTimestamps.medianDeltaMs)}, jitter σ {fmtMs(
        snapshot.frameTimestamps.jitterStddevMs,
      )} over {snapshot.frameTimestamps.count} deltas
      <Verdict
        verdict={jitterVerdict({
          jitterStddevMs: snapshot.frameTimestamps.jitterStddevMs,
          medianDeltaMs: snapshot.frameTimestamps.medianDeltaMs,
        })}
      />
    </dd>
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
        needs ≥ 2×600 processed frames (~20 s at 60 fps)
      {/if}
    </dd>
  </dl>
{/if}

<style>
  .elapsed {
    font-family: monospace;
    font-size: 0.9rem;
  }

  .bars {
    display: block;
    margin: 0.5rem 0;
    border: 1px solid #2c3850;
    border-radius: 0.375rem;
    max-width: 100%;
  }
</style>
