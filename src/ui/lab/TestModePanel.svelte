<script lang="ts">
  import { getAudioService } from '../../core/audio/audio-service'
  import {
    CrossingDetector,
    attachDetectorToPipeline,
    type PausableFrameSource,
  } from '../../core/detection/crossing-detector'
  import type { CrossingDirection } from '../../core/detection/crossing-events'
  import {
    DEFAULT_TRIGGER_SUGGESTION_CONFIG,
    TriggerLevelCollector,
  } from '../../core/detection/trigger-suggest'
  import type { Course } from '../../core/domain/types'
  import { SessionEngine } from '../../core/session/session-engine'
  import { errorText, fmtNumber } from '../diag/format'
  import type { LabSession } from './lab-session'

  let { session }: { session: LabSession } = $props()

  // CrossingDetector's validator rejects triggerLevel ≤ 0. The tunables
  // slider min already matches, but clamp anyway: any other tunables writer
  // reaching 0 would otherwise throw uncaught inside the live-tracking
  // $effect (killing the flush) or the arm click handler.
  const MIN_DETECTOR_TRIGGER_LEVEL = 0.01
  function detectorTriggerLevel(level: number): number {
    return Math.max(MIN_DETECTOR_TRIGGER_LEVEL, level)
  }

  const audio = getAudioService()
  let audioPrimed = $state(audio.primed)
  let audioError = $state<string | null>(null)

  let direction = $state<CrossingDirection>('ltr')
  let testRunning = $state(false)
  let crossingInProgress = $state(false)
  let log = $state<{ timestampMs: number; direction: CrossingDirection }[]>([])
  const MAX_LOG_ENTRIES = 50

  // Non-reactive wiring, alive only while testRunning.
  let engine: SessionEngine | null = null
  let detector: CrossingDetector | null = null
  let detachDetector: (() => void) | null = null

  function labCourse(courseDirection: CrossingDirection): Course {
    return {
      id: 'lab-test-mode',
      name: 'Lab test mode',
      direction: courseDirection,
      // Irrelevant here: test mode applies no min-lap-time debounce
      // (product.md, Test mode).
      minLapTimeMs: 0,
      createdAt: new Date().toISOString(),
    }
  }

  // Adapts the lab session's sample fan-out + pause seam to the detector's
  // attach helper: start() subscribes instead of starting the (already
  // running) pipeline, setPause forwards to it.
  function pausableSampleSource(): PausableFrameSource {
    let unsubscribe: (() => void) | null = null
    return {
      start(onSample) {
        unsubscribe = session.addSampleListener(onSample)
      },
      stop() {
        unsubscribe?.()
        unsubscribe = null
      },
      setPause(paused) {
        session.setPipelinePause(paused)
      },
    }
  }

  function startTestMode(): void {
    if (testRunning || !session.captureRunning) return
    const nextEngine = new SessionEngine({
      now: () => new Date(),
      callbacks: {
        onTestCrossing: (event) => {
          audio.beep()
          log = [
            { timestampMs: event.timestampMs, direction: event.direction },
            ...log,
          ].slice(0, MAX_LOG_ENTRIES)
        },
      },
    })
    nextEngine.startTest(labCourse(direction))
    const nextDetector = new CrossingDetector({
      triggerLevel: detectorTriggerLevel(session.tunables.triggerLevel),
    })
    const source = pausableSampleSource()
    attachDetectorToPipeline(source, nextDetector, (event) => nextEngine.onCrossing(event))
    // Registered after the attach, so it observes the detector state AFTER
    // this frame's onSample. Flips reactive state only on change (event
    // frequency), never per frame.
    const offIndicator = session.addSampleListener(() => {
      if (nextDetector.crossingInProgress !== crossingInProgress) {
        crossingInProgress = nextDetector.crossingInProgress
      }
    })
    engine = nextEngine
    detector = nextDetector
    detachDetector = () => {
      source.stop()
      offIndicator()
    }
    testRunning = true
  }

  function stopTestMode(): void {
    if (!testRunning) return
    detachDetector?.()
    detachDetector = null
    // The detector may have left the EMA paused mid-candidate.
    session.setPipelinePause(false)
    engine?.stop()
    engine = null
    detector = null
    crossingInProgress = false
    testRunning = false
  }

  function onDirectionChange(): void {
    // Test mode has no accumulated state — retargeting is just a new course.
    if (testRunning) engine?.startTest(labCourse(direction))
  }

  async function primeAudio(): Promise<void> {
    audioError = null
    try {
      await audio.primeOnGesture()
      audioPrimed = true
    } catch (error) {
      audioError = errorText(error)
    }
  }

  // Trigger suggestion (plan 04 item 6 wired into calibration): observe the
  // next quietWindowMs of samples, then offer the collector's suggestion.
  const quietWindowMs = DEFAULT_TRIGGER_SUGGESTION_CONFIG.quietWindowMs
  let collecting = $state(false)
  let observedMs = $state(0)
  let suggestion = $state<number | null>(null)
  let collectionAborted = $state(false)
  let stopCollecting: (() => void) | null = null
  // Identity snapshot of session.tunables at collection start: the lab
  // session replaces the object wholesale on every update (ROI included), so
  // an identity change means the observed scene's settings changed.
  let collectionTunables: unknown = null

  function suggestTrigger(): void {
    if (collecting || !session.captureRunning) return
    suggestion = null
    collectionAborted = false
    observedMs = 0
    collectionTunables = session.tunables
    const collector = new TriggerLevelCollector()
    const offSamples = session.addSampleListener((sample) => collector.add(sample))
    const poll = setInterval(() => {
      observedMs = collector.observedSpanMs
      const ready = collector.suggestion
      if (ready !== undefined) {
        suggestion = ready
        stopCollecting?.()
      } else if (!session.captureRunning) {
        stopCollecting?.()
      }
    }, 200)
    stopCollecting = () => {
      offSamples()
      clearInterval(poll)
      stopCollecting = null
      collecting = false
    }
    collecting = true
  }

  function applySuggestion(): void {
    if (suggestion !== null) session.updateTunables({ triggerLevel: suggestion })
  }

  // detection.md: the collector's quiet observation resets when the scene
  // setup changes. Any tunables update mid-window (slider or ROI — both flow
  // through session.tunables) invalidates the samples already observed, so
  // abort rather than suggest from a mixed window.
  $effect(() => {
    const current = session.tunables
    if (collecting && current !== collectionTunables) {
      stopCollecting?.()
      collectionAborted = true
    }
  })

  // Auto-stop with capture (manual stop and external track death alike).
  $effect(() => {
    if (testRunning && !session.captureRunning) stopTestMode()
  })

  // The tunables slider applies live to the pipeline; the detector follows.
  $effect(() => {
    const triggerLevel = detectorTriggerLevel(session.tunables.triggerLevel)
    if (testRunning) detector?.updateConfig({ triggerLevel })
  })

  $effect(() => () => {
    stopTestMode()
    stopCollecting?.()
  })
</script>

<div class="controls">
  <button onclick={startTestMode} disabled={testRunning || !session.captureRunning}>
    Start test mode
  </button>
  <button onclick={stopTestMode} disabled={!testRunning}>Stop test mode</button>
  <label>
    direction
    <select bind:value={direction} onchange={onDirectionChange}>
      <option value="ltr">ltr</option>
      <option value="rtl">rtl</option>
    </select>
  </label>
  {#if !audioPrimed}
    <button onclick={() => void primeAudio()}>Prime audio</button>
  {/if}
  {#if testRunning}
    <span class="state">
      crossing:
      <span class="indicator" class:active={crossingInProgress}>
        {crossingInProgress ? 'IN PROGRESS' : 'quiet'}
      </span>
    </span>
  {/if}
</div>

{#if audioError !== null}
  <p class="error">audio priming failed: {audioError}</p>
{/if}

<div class="controls">
  <button onclick={suggestTrigger} disabled={collecting || !session.captureRunning}>
    Suggest trigger
  </button>
  {#if collecting}
    <span class="state">
      observing quiet scene… {(observedMs / 1000).toFixed(1)} / {(quietWindowMs / 1000).toFixed(0)} s
    </span>
  {/if}
  {#if collectionAborted}
    <span class="state">suggestion aborted — settings changed</span>
  {/if}
  {#if suggestion !== null}
    <span class="state">suggested trigger level: <code>{fmtNumber(suggestion, 3)}</code></span>
    <button onclick={applySuggestion}>Apply</button>
  {/if}
</div>

{#if !session.captureRunning}
  <p class="hint">
    Start the camera first — test mode runs the crossing detector over the live pipeline and beeps
    on every correct-direction crossing (no min-lap debounce; wrong direction stays silent). Keep
    the scene quiet while suggesting a trigger level.
  </p>
{/if}

{#if log.length > 0}
  <table>
    <thead>
      <tr>
        <th>Capture time</th>
        <th>Direction</th>
      </tr>
    </thead>
    <tbody>
      {#each log as entry (entry.timestampMs)}
        <tr>
          <td class="num">{(entry.timestampMs / 1000).toFixed(3)} s</td>
          <td>{entry.direction}</td>
        </tr>
      {/each}
    </tbody>
  </table>
{:else if testRunning}
  <p class="hint">No crossings yet — wave a hand through the gate in the course direction.</p>
{/if}

<style>
  .state {
    font-size: 0.85rem;
    opacity: 0.9;
  }

  label {
    font-size: 0.85rem;
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
  }

  .indicator {
    padding: 0.05rem 0.4rem;
    border-radius: 0.375rem;
    background: #1b2740;
  }

  .indicator.active {
    background: #14532d;
    color: #86efac;
  }
</style>
