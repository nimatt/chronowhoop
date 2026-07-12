<script lang="ts">
  import {
    CpuPipelineProbe,
    type CpuPipelineSnapshot,
  } from '../../core/cpu-pipeline/cpu-pipeline-probe'
  import { DEFAULT_STRIP_REDUCE_CONFIG } from '../../core/cpu-pipeline/strip-reduce'
  import { ASSUMED_FPS, frameIntervalForFps, latencyVerdict } from '../../core/diag/verdicts'
  import { FrameLoop } from '../../core/frame-loop/frame-loop'
  import type { LatencyStats } from '../../core/gpu/readback-stats'
  import type { DiagSession } from './diag-session'
  import Verdict from './Verdict.svelte'
  import { errorText, fmtClock, fmtFps, fmtMs, fmtNumber } from './format'

  let { session }: { session: DiagSession } = $props()

  const SUSTAIN_MS = 5 * 60 * 1000

  let willReadFrequently = $state<'on' | 'off'>('on')
  let running = $state(false)
  let sustainMode = $state(false)
  let sustainDone = $state(false)
  let elapsedMs = $state(0)
  let snapshot = $state<CpuPipelineSnapshot | null>(null)
  let startFailure = $state<string | null>(null)
  let autoStopNotice = $state<string | null>(null)
  let startedVideo = $state.raw<HTMLVideoElement | null>(null)

  let probe: CpuPipelineProbe | null = null
  let loop: FrameLoop | null = null
  let pollTimer: ReturnType<typeof setInterval> | undefined
  let startedAtMs = 0
  let barsCanvas: HTMLCanvasElement | null = null

  const ready = $derived(session.video !== null)
  const frameIntervalMs = $derived(frameIntervalForFps(session.measuredFps))
  const frameIntervalAssumed = $derived(session.measuredFps === null)
  const gateFps = $derived(session.measuredFps ?? ASSUMED_FPS)
  // Declared CPU budget (ADR 0008, CPU-pipeline probe section): the whole
  // per-frame pipeline — downscale, readback, reduce — must fit in HALF a
  // frame interval at the granted rate, median and p95, leaving the other
  // half for the state machine, UI, and speech on the same thread.
  const cpuBudgetMs = $derived(frameIntervalMs / 2)

  function drawBars(energies: readonly number[], workingPixels: number) {
    const canvas = barsCanvas
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx || energies.length === 0) return
    const capacity = workingPixels / energies.length
    const barWidth = canvas.width / energies.length
    ctx.fillStyle = '#16233c'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = '#7ea6ff'
    energies.forEach((energy, i) => {
      const h = capacity > 0 ? Math.min(1, energy / capacity) * canvas.height : 0
      ctx.fillRect(i * barWidth + 1, canvas.height - h, barWidth - 2, h)
    })
  }

  function start(sustain: boolean) {
    const video = session.video
    if (video === null || running) return
    startFailure = null
    autoStopNotice = null
    snapshot = null
    sustainDone = false
    try {
      const started = new CpuPipelineProbe(video, {
        willReadFrequently: willReadFrequently === 'on',
      })
      probe = started
      loop = new FrameLoop(video, (sample) => {
        started.onFrame(sample)
        const { width, height } = started.workingSize
        drawBars(started.lastEnergies, width * height)
      })
      loop.start()
    } catch (error) {
      startFailure = errorText(error)
      probe = null
      loop = null
      return
    }
    startedVideo = video
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
    loop?.stop()
    loop = null
    clearInterval(pollTimer)
    pollTimer = undefined
    if (probe !== null) {
      snapshot = probe.snapshot()
      probe = null
    }
    running = false
    sustainMode = false
    startedVideo = null
  }

  $effect(() => {
    if (running && session.video !== startedVideo) {
      stop()
      autoStopNotice = 'Stopped automatically: the camera changed mid-run.'
    }
  })

  $effect(() => () => stop())

  const stageRows = $derived<[string, LatencyStats | undefined, boolean][]>(
    snapshot === null
      ? []
      : [
          ['drawImage (downscale)', snapshot.stages.draw, false],
          ['getImageData (readback)', snapshot.stages.read, false],
          ['reduce (luminance/EMA/strips)', snapshot.stages.reduce, false],
          ['total (overall)', snapshot.stages.total, true],
          ['total (rolling)', snapshot.rollingTotal, true],
        ],
  )
</script>

<p class="hint">
  WebGPU-free candidate pipeline: video → {DEFAULT_STRIP_REDUCE_CONFIG.stripCount}-strip motion
  energy on the CPU at ~256 px working width. Wave a hand in front of the camera — the bars are the
  live strip energies.
</p>

<div class="controls">
  <label>
    willReadFrequently
    <select bind:value={willReadFrequently} disabled={running}>
      <option value="on">on (CPU-backed canvas)</option>
      <option value="off">off (GPU-backed canvas)</option>
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
  <p class="hint">Start the camera first — this probe reuses its preview stream.</p>
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
    <dt>working resolution</dt>
    <dd>
      {snapshot.workingWidth}×{snapshot.workingHeight} (willReadFrequently {snapshot.willReadFrequently
        ? 'on'
        : 'off'})
    </dd>
    <dt>processed</dt>
    <dd>{snapshot.processed} / {snapshot.ticks} ticks ({fmtNumber(snapshot.processedPerSecond, 1)}/s)</dd>
    <dt>rolling tick rate</dt>
    <dd>{fmtFps(snapshot.rollingTicksPerSecond)}</dd>
    <dt>skipped (no video)</dt>
    <dd>{snapshot.skippedNoVideo}</dd>
    <dt>background resets</dt>
    <dd>{snapshot.resets}</dd>
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

  .bars {
    display: block;
    margin: 0.5rem 0;
    border: 1px solid #2c3850;
    border-radius: 0.375rem;
    max-width: 100%;
  }
</style>
