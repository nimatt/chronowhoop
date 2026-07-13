<script lang="ts">
  import { getAudioService } from '../../core/audio/audio-service'
  import { CrossingDetector } from '../../core/detection/crossing-detector'
  import type { CrossingDirection } from '../../core/detection/crossing-events'
  import type { Course } from '../../core/domain/types'
  import { SessionEngine } from '../../core/session/session-engine'
  import { errorText, fmtNumber } from '../diag/format'
  import type { CaptureSession } from '../shared/capture-session'
  import {
    attachDetectorToCaptureSession,
    detectorTriggerLevel,
  } from '../shared/detector-attachment'
  import { createTriggerCollection } from '../shared/trigger-collection.svelte'

  let { session }: { session: CaptureSession } = $props()

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
    const detach = attachDetectorToCaptureSession(session, nextDetector, (event) =>
      nextEngine.onCrossing(event),
    )
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
      detach()
      offIndicator()
    }
    testRunning = true
  }

  function stopTestMode(): void {
    if (!testRunning) return
    detachDetector?.()
    detachDetector = null
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

  // Trigger suggestion (plan 04 item 6 wired into calibration). The session
  // prop never changes after mount (created once per screen), so capturing it
  // at init is deliberate.
  // svelte-ignore state_referenced_locally
  const trigger = createTriggerCollection(session)

  // Auto-stop with capture (manual stop and external track death alike).
  $effect(() => {
    if (testRunning && !session.captureRunning) stopTestMode()
  })

  // The tunables slider applies live to the pipeline; the detector follows.
  $effect(() => {
    const triggerLevel = detectorTriggerLevel(session.tunables.triggerLevel)
    if (testRunning) detector?.updateConfig({ triggerLevel })
  })

  $effect(() => () => stopTestMode())
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
  <button onclick={() => trigger.start()} disabled={trigger.collecting || !session.captureRunning}>
    Suggest trigger
  </button>
  {#if trigger.collecting}
    <span class="state">
      observing quiet scene… {(trigger.observedMs / 1000).toFixed(1)} / {(
        trigger.quietWindowMs / 1000
      ).toFixed(0)} s
    </span>
  {/if}
  {#if trigger.aborted}
    <span class="state">suggestion aborted — settings changed</span>
  {/if}
  {#if trigger.suggestion !== null}
    <span class="state">
      suggested trigger level: <code>{fmtNumber(trigger.suggestion, 3)}</code>
    </span>
    <button onclick={() => trigger.apply()}>Apply</button>
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
