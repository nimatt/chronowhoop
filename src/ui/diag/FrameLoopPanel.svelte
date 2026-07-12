<script lang="ts">
  import { fpsVerdict, jitterVerdict } from '../../core/diag/verdicts'
  import { FrameLoop } from '../../core/frame-loop/frame-loop'
  import {
    FrameStatsWindow,
    TIMESTAMP_SOURCES,
    type FrameLoopStats,
  } from '../../core/frame-loop/frame-stats'
  import type { DiagSession } from './diag-session'
  import Verdict from './Verdict.svelte'
  import { errorText, fmtFps, fmtMs, fmtPct } from './format'

  let { session }: { session: DiagSession } = $props()

  let running = $state(false)
  let stats = $state<FrameLoopStats | null>(null)
  let startFailure = $state<string | null>(null)
  // Per-frame counter: updated via direct DOM writes from the FrameLoop
  // subscriber (roadmap per-frame rule), never through $state.
  let frameCounterElement = $state<HTMLElement | null>(null)
  // The video element this run started against — the auto-stop guard compares
  // identity, not just null, so a camera restart that swaps in a new element
  // can't leave the loop measuring the old detached one.
  let startedVideo = $state.raw<HTMLVideoElement | null>(null)
  // Set only by the identity-guard auto-stop, so an aborted run is
  // distinguishable from a manual Stop; cleared on the next start.
  let autoStopNotice = $state<string | null>(null)

  const statsWindow = new FrameStatsWindow()
  let loop: FrameLoop | null = null
  let pollTimer: ReturnType<typeof setInterval> | undefined

  function pollStats() {
    stats = statsWindow.stats()
    if (stats.measuredFps !== undefined) session.measuredFps = stats.measuredFps
  }

  function start() {
    const video = session.video
    if (video === null || running) return
    startFailure = null
    autoStopNotice = null
    statsWindow.reset()
    try {
      loop = new FrameLoop(video, (sample) => {
        statsWindow.add(sample)
        if (frameCounterElement !== null) {
          // Intentional direct write: the counter span's text is owned solely
          // by this subscriber (static "0" initial, no Svelte expressions), so
          // the runtime never diffs it.
          // eslint-disable-next-line svelte/no-dom-manipulating
          frameCounterElement.textContent = String(sample.frameIndex + 1)
        }
      })
      loop.start()
    } catch (error) {
      startFailure = errorText(error)
      loop = null
      return
    }
    startedVideo = video
    running = true
    pollTimer = setInterval(pollStats, 1000)
  }

  function stop() {
    loop?.stop()
    loop = null
    clearInterval(pollTimer)
    pollTimer = undefined
    if (running) pollStats()
    running = false
    startedVideo = null
  }

  $effect(() => {
    if (running && session.video !== startedVideo) {
      stop()
      autoStopNotice = 'Stopped automatically: the camera changed mid-run.'
    }
  })

  $effect(() => () => stop())
</script>

<div class="controls">
  <button onclick={start} disabled={running || session.video === null}>Start measuring</button>
  <button onclick={stop} disabled={!running}>Stop</button>
  <span class="live">
    frames seen: <span bind:this={frameCounterElement} class="counter">0</span>
  </span>
</div>

{#if session.video === null}
  <p class="hint">Start the camera first — the frame loop measures the live preview element.</p>
{/if}

{#if startFailure !== null}
  <p class="error">Frame loop failed to start: {startFailure}</p>
{/if}

{#if autoStopNotice !== null}
  <p class="error">{autoStopNotice}</p>
{/if}

{#if stats !== null}
  <dl class="kv">
    <dt>measured fps</dt>
    <dd>
      {fmtFps(stats.measuredFps)}
      <Verdict verdict={fpsVerdict(stats.measuredFps)} />
    </dd>
    <dt>dropped frames (window)</dt>
    <dd>{stats.droppedFrameEstimate ?? 'can’t tell'}</dd>
    <dt>window</dt>
    <dd>{stats.frameCount} frames / {fmtMs(stats.windowDurationMs, 0)}</dd>
  </dl>
  {#if fpsVerdict(stats.measuredFps) === 'warn'}
    <p class="hint">
      30 fps class: acceptable only with the explicit note that ADR 0003’s ±1-frame claim widens
      to ~33 ms (record this in the device matrix).
    </p>
  {/if}
  <div class="table-scroll">
    <table>
      <thead>
        <tr>
          <th>Timestamp source</th>
          <th>Availability</th>
          <th>Median Δ</th>
          <th>Jitter σ</th>
          <th>Max deviation</th>
          <th>Gate (σ ≤ ½ × median Δ)</th>
        </tr>
      </thead>
      <tbody>
        {#each TIMESTAMP_SOURCES as source (source)}
          {@const sourceStats = stats.sources[source]}
          <tr>
            <td><code>{source}</code></td>
            <td class="num">{fmtPct(sourceStats.availability)} ({sourceStats.availableFrames})</td>
            <td class="num">{fmtMs(sourceStats.medianDeltaMs)}</td>
            <td class="num">{fmtMs(sourceStats.jitterStddevMs, 3)}</td>
            <td class="num">{fmtMs(sourceStats.jitterMaxDeviationMs)}</td>
            <td><Verdict verdict={jitterVerdict(sourceStats)} /></td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<style>
  .live {
    font-size: 0.85rem;
    opacity: 0.8;
  }

  .counter {
    font-family: monospace;
  }
</style>
