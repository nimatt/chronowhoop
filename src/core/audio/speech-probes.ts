import type { AudioService, Clock, SpeechHandle } from './audio-service'

// Probes for the exact speechSynthesis queue patterns Phase 5's announcer
// depends on (plan 02, work item 7). Each probe resolves to a plain
// serializable result object: the human at the phone judges audibility, the
// probe records event timings. Timeouts guarantee a wedged synthesis engine
// yields a "timed out" step instead of hanging the /diag panel forever.

export type DelayFn = (ms: number) => Promise<void>

export type SpeechProbeName = 'rapid-back-to-back' | 'cancel-then-speak' | 'speak-after-return'

export interface SpeechProbeStep {
  label: string
  text: string
  startFired: boolean
  endFired: boolean
  errorFired: boolean
  error: string | null
  /** start event delay after speak() was called, ms; null if start never fired. */
  startDelayMs: number | null
  /** start-to-end duration, ms; null unless both fired. */
  durationMs: number | null
  /** Gap between the previous step's end and this step's start, ms. */
  gapFromPreviousEndMs: number | null
  /** True when neither end nor error fired within the timeout. */
  timedOut: boolean
}

export interface SpeechProbeResult {
  probe: SpeechProbeName
  ok: boolean
  detail: string
  steps: SpeechProbeStep[]
  totalMs: number
}

export interface SpeechProbeOptions {
  /** Bounds each wait on utterance events; default 5000 ms. */
  timeoutMs?: number
  delay?: DelayFn
  now?: Clock
}

export interface CancelThenSpeakOptions extends SpeechProbeOptions {
  /** How long to let the first utterance run before cancel(); default 500 ms. */
  cancelAfterMs?: number
}

export const DEFAULT_PROBE_TIMEOUT_MS = 5000
export const DEFAULT_CANCEL_AFTER_MS = 500

const defaultDelay: DelayFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const defaultNow: Clock = () => performance.now()

async function raceTimeout(event: Promise<void>, delay: DelayFn, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    event.then(() => true),
    delay(timeoutMs).then(() => false),
  ])
}

async function stepFromHandle(
  label: string,
  handle: SpeechHandle,
  previous: SpeechHandle | null,
  delay: DelayFn,
  timeoutMs: number,
): Promise<SpeechProbeStep> {
  const settledInTime = await raceTimeout(handle.settled, delay, timeoutMs)
  const { startedAt, endedAt, error } = handle
  const endFired = settledInTime && error === null
  const gapFromPreviousEndMs =
    previous?.endedAt != null && startedAt != null ? startedAt - previous.endedAt : null
  return {
    label,
    text: handle.text,
    startFired: startedAt !== null,
    endFired,
    errorFired: error !== null,
    error,
    startDelayMs: startedAt !== null ? startedAt - handle.queuedAt : null,
    durationMs: startedAt !== null && endedAt !== null ? endedAt - startedAt : null,
    gapFromPreviousEndMs,
    timedOut: !settledInTime,
  }
}

/**
 * Pattern 1: speak three short utterances immediately after each other, as the
 * announcer does when laps come in faster than speech completes.
 */
export async function probeRapidBackToBackSpeech(
  service: AudioService,
  options: SpeechProbeOptions = {},
): Promise<SpeechProbeResult> {
  const delay = options.delay ?? defaultDelay
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  const now = options.now ?? defaultNow
  const startedProbeAt = now()

  const texts = ['twelve four', 'best eleven nine', 'thirteen two']
  const handles = texts.map((text) => service.speak(text))

  const steps: SpeechProbeStep[] = []
  for (const [index, handle] of handles.entries()) {
    steps.push(
      await stepFromHandle(
        `utterance ${index + 1} of ${handles.length}`,
        handle,
        handles[index - 1] ?? null,
        delay,
        timeoutMs,
      ),
    )
  }

  const ok = steps.every((step) => step.endFired && !step.errorFired && !step.timedOut)
  return {
    probe: 'rapid-back-to-back',
    ok,
    detail: ok
      ? 'all queued utterances started and ended'
      : 'at least one queued utterance errored or timed out',
    steps,
    totalMs: now() - startedProbeAt,
  }
}

function cancelThenSpeakDetail(second: SpeechProbeStep): string {
  if (second.startFired) {
    if (second.errorFired) return 'post-cancel utterance started but errored'
    if (second.timedOut) {
      return 'post-cancel utterance started but never finished within the timeout (mid-utterance wedge signature)'
    }
    return 'utterance spoken immediately after cancel() started normally'
  }
  if (second.timedOut) {
    return 'post-cancel utterance never started within the timeout (wedged engine signature)'
  }
  return 'post-cancel utterance settled without starting (fast error, not the wedge signature)'
}

/**
 * Pattern 2: cancel() mid-utterance followed by an immediate speak() — the
 * cancel-and-replace announcer policy. Historically wedges iOS Safari: the
 * second utterance's start event never fires. The verdict must distinguish a
 * genuine wedge (no event at all within the timeout) from a fast pre-start
 * error, which is a well-behaved engine rejecting the utterance.
 */
export async function probeCancelThenSpeak(
  service: AudioService,
  options: CancelThenSpeakOptions = {},
): Promise<SpeechProbeResult> {
  const delay = options.delay ?? defaultDelay
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  const cancelAfterMs = options.cancelAfterMs ?? DEFAULT_CANCEL_AFTER_MS
  const now = options.now ?? defaultNow
  const startedProbeAt = now()

  const first = service.speak(
    'this is a deliberately long announcement that should still be speaking when it gets canceled',
  )
  await delay(cancelAfterMs)
  service.cancel()
  const second = service.speak('best twelve one')

  const firstStep = await stepFromHandle('long utterance, canceled mid-speech', first, null, delay, timeoutMs)
  const secondStep = await stepFromHandle('immediate speak() after cancel()', second, null, delay, timeoutMs)

  return {
    probe: 'cancel-then-speak',
    ok: secondStep.startFired && !secondStep.errorFired && !secondStep.timedOut,
    detail: cancelThenSpeakDetail(secondStep),
    steps: [firstStep, secondStep],
    totalMs: now() - startedProbeAt,
  }
}

function speakAfterReturnDetail(step: SpeechProbeStep): string {
  if (step.startFired) {
    if (step.errorFired) return 'speech started after returning but errored mid-utterance'
    return step.timedOut
      ? 'speech started after returning but never finished within the timeout (mid-utterance wedge signature)'
      : 'speech started after background/foreground without re-priming'
  }
  return 'speech did not start after backgrounding — re-prime on visibilitychange may be required'
}

/**
 * Pattern 3: speak() after a background/foreground cycle without a new
 * gesture. Needs UI cooperation: the /diag panel instructs the user to
 * background the app and calls this on demand after they return.
 */
export async function probeSpeakAfterReturn(
  service: AudioService,
  options: SpeechProbeOptions = {},
): Promise<SpeechProbeResult> {
  const delay = options.delay ?? defaultDelay
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  const now = options.now ?? defaultNow
  const startedProbeAt = now()

  const handle = service.speak('back from background')
  const step = await stepFromHandle('speak() after returning, no new gesture', handle, null, delay, timeoutMs)

  return {
    probe: 'speak-after-return',
    ok: step.startFired && !step.errorFired && !step.timedOut,
    detail: speakAfterReturnDetail(step),
    steps: [step],
    totalMs: now() - startedProbeAt,
  }
}
