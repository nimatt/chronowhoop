export type Clock = () => number

export interface VoiceLike {
  name: string
  lang: string
  localService: boolean
  default: boolean
}

export interface SpeechErrorEventLike {
  error?: string
}

export interface UtteranceLike {
  text: string
  rate: number
  volume: number
  voice: VoiceLike | null
  onstart: (() => void) | null
  onend: (() => void) | null
  onerror: ((event: SpeechErrorEventLike) => void) | null
}

export interface SpeechSynthesisLike {
  speak(utterance: UtteranceLike): void
  cancel(): void
  getVoices(): VoiceLike[]
  addEventListener(type: 'voiceschanged', listener: () => void): void
}

export interface OscillatorLike {
  frequency: { value: number }
  connect(destination: unknown): unknown
  start(when?: number): void
  stop(when?: number): void
}

export interface GainLike {
  gain: { value: number }
  connect(destination: unknown): unknown
}

export interface AudioContextLike {
  state: string
  currentTime: number
  destination: unknown
  resume(): Promise<void>
  createOscillator(): OscillatorLike
  createGain(): GainLike
}

export type SpeechEventType = 'queued' | 'start' | 'end' | 'error'

export interface SpeechLifecycleEvent {
  utteranceId: number
  text: string
  type: SpeechEventType
  timestamp: number
  error?: string
}

export interface SpeakOptions {
  rate?: number
  volume?: number
  voice?: VoiceLike
}

// Product spec: "slightly elevated rate" for lap announcements. 1.2 is an
// assumption pending on-device listening tests (see 02-device-spike.notes.md).
export const DEFAULT_SPEECH_RATE = 1.2

export const DEFAULT_BEEP_DURATION_MS = 80
export const DEFAULT_BEEP_FREQ_HZ = 1000
const BEEP_GAIN = 0.15

export interface SpeechHandle {
  readonly id: number
  readonly text: string
  readonly queuedAt: number
  readonly startedAt: number | null
  readonly endedAt: number | null
  readonly error: string | null
  /**
   * Resolves when the utterance's start event fires, or at settle time if it
   * never starts — `startedAt === null` distinguishes the two (never rejects).
   */
  readonly started: Promise<void>
  /** Resolves when the utterance ends or errors (never rejects). */
  readonly settled: Promise<void>
}

function defaultSpeechSynthesis(): SpeechSynthesisLike | undefined {
  const global = globalThis as { speechSynthesis?: SpeechSynthesisLike }
  return global.speechSynthesis
}

function defaultCreateUtterance(text: string): UtteranceLike {
  const global = globalThis as {
    SpeechSynthesisUtterance?: new (text: string) => unknown
  }
  if (!global.SpeechSynthesisUtterance) {
    throw new Error('SpeechSynthesisUtterance is not available')
  }
  // The DOM type's voice/handler fields are declared with browser-specific
  // event types that don't structurally match the narrowed "…Like" shapes,
  // even though every runtime assignment the service makes is valid. Assert
  // once at this boundary.
  return new global.SpeechSynthesisUtterance(text) as UtteranceLike
}

function defaultCreateAudioContext(): AudioContextLike {
  const global = globalThis as { AudioContext?: new () => AudioContextLike }
  if (!global.AudioContext) {
    throw new Error('AudioContext is not available')
  }
  return new global.AudioContext()
}

const defaultClock: Clock = () => performance.now()

// Preference order for the announcement voice: a local (on-device) English
// voice beats a network one because announcements must work offline, and the
// platform-default English voice beats other English voices. This heuristic
// is an assumption to be validated on-device (see 02-device-spike.notes.md).
function scoreVoice(voice: VoiceLike): number {
  if (!voice.lang.toLowerCase().startsWith('en')) return 0
  let score = 1
  if (voice.localService) score += 2
  if (voice.default) score += 1
  return score
}

export function pickDefaultEnglishVoice(voices: readonly VoiceLike[]): VoiceLike | null {
  let best: VoiceLike | null = null
  let bestScore = 0
  for (const voice of voices) {
    const score = scoreVoice(voice)
    if (score > bestScore) {
      best = voice
      bestScore = score
    }
  }
  return best
}

export interface AudioServiceDeps {
  speechSynthesis?: SpeechSynthesisLike
  createUtterance?: (text: string) => UtteranceLike
  createAudioContext?: () => AudioContextLike
  now?: Clock
}

interface MutableHandleState {
  startedAt: number | null
  endedAt: number | null
  error: string | null
}

export class AudioService {
  readonly #speechSynthesis: SpeechSynthesisLike | undefined
  readonly #createUtterance: (text: string) => UtteranceLike
  readonly #createAudioContext: () => AudioContextLike
  readonly #now: Clock

  #audioContext: AudioContextLike | null = null
  #primed = false
  #primePromise: Promise<void> | null = null
  #voices: readonly VoiceLike[] = []
  #defaultVoice: VoiceLike | null = null
  #nextUtteranceId = 1
  readonly #listeners = new Set<(event: SpeechLifecycleEvent) => void>()
  // Strong references to in-flight utterances until end/error fires: iOS
  // Safari has historically GC'd pending utterances, silently dropping their
  // events. Deliberately never cleared on cancel() — a wedged engine that
  // fires no terminal event shows up here as a stuck count.
  readonly #inFlight = new Map<number, UtteranceLike>()

  constructor(deps: AudioServiceDeps = {}) {
    this.#speechSynthesis = deps.speechSynthesis ?? defaultSpeechSynthesis()
    this.#createUtterance = deps.createUtterance ?? defaultCreateUtterance
    this.#createAudioContext = deps.createAudioContext ?? defaultCreateAudioContext
    this.#now = deps.now ?? defaultClock
    this.#speechSynthesis?.addEventListener('voiceschanged', () => this.#refreshVoices())
    this.#refreshVoices()
  }

  get primed(): boolean {
    return this.#primed
  }

  get voices(): readonly VoiceLike[] {
    return this.#voices
  }

  get defaultVoice(): VoiceLike | null {
    return this.#defaultVoice
  }

  get pendingUtteranceCount(): number {
    return this.#inFlight.size
  }

  /**
   * Must be called from a user gesture. Creates/resumes the AudioContext and
   * speaks a zero-volume utterance to unlock speechSynthesis. Idempotent;
   * a failed attempt clears itself so a later gesture can retry.
   */
  primeOnGesture(): Promise<void> {
    this.#primePromise ??= this.#prime().then(
      () => {
        this.#primed = true
      },
      (error: unknown) => {
        this.#primePromise = null
        throw error
      },
    )
    return this.#primePromise
  }

  async #prime(): Promise<void> {
    const context = this.#ensureAudioContext()
    if (context.state === 'suspended') {
      await context.resume()
    }
    if (this.#speechSynthesis) {
      this.speak('', { volume: 0 })
    }
  }

  #ensureAudioContext(): AudioContextLike {
    this.#audioContext ??= this.#createAudioContext()
    return this.#audioContext
  }

  onEvent(listener: (event: SpeechLifecycleEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #emit(event: SpeechLifecycleEvent): void {
    for (const listener of this.#listeners) listener(event)
  }

  speak(text: string, opts: SpeakOptions = {}): SpeechHandle {
    const id = this.#nextUtteranceId++
    const queuedAt = this.#now()
    const state: MutableHandleState = { startedAt: null, endedAt: null, error: null }

    let resolveStarted!: () => void
    let resolveSettled!: () => void
    const started = new Promise<void>((resolve) => (resolveStarted = resolve))
    const settled = new Promise<void>((resolve) => (resolveSettled = resolve))

    const handle: SpeechHandle = {
      id,
      text,
      queuedAt,
      started,
      settled,
      get startedAt() {
        return state.startedAt
      },
      get endedAt() {
        return state.endedAt
      },
      get error() {
        return state.error
      },
    }

    this.#emit({ utteranceId: id, text, type: 'queued', timestamp: queuedAt })

    if (!this.#speechSynthesis) {
      state.error = 'speechSynthesis is not available'
      state.endedAt = this.#now()
      this.#emit({
        utteranceId: id,
        text,
        type: 'error',
        timestamp: state.endedAt,
        error: state.error,
      })
      resolveStarted()
      resolveSettled()
      return handle
    }

    const utterance = this.#createUtterance(text)
    utterance.rate = opts.rate ?? DEFAULT_SPEECH_RATE
    utterance.volume = opts.volume ?? 1
    const voice = opts.voice ?? this.#defaultVoice
    if (voice) utterance.voice = voice

    this.#inFlight.set(id, utterance)

    utterance.onstart = () => {
      state.startedAt = this.#now()
      this.#emit({ utteranceId: id, text, type: 'start', timestamp: state.startedAt })
      resolveStarted()
    }
    utterance.onend = () => {
      state.endedAt = this.#now()
      this.#inFlight.delete(id)
      this.#emit({ utteranceId: id, text, type: 'end', timestamp: state.endedAt })
      resolveStarted()
      resolveSettled()
    }
    utterance.onerror = (event) => {
      state.endedAt = this.#now()
      state.error = event.error ?? 'unknown'
      this.#inFlight.delete(id)
      this.#emit({
        utteranceId: id,
        text,
        type: 'error',
        timestamp: state.endedAt,
        error: state.error,
      })
      resolveStarted()
      resolveSettled()
    }

    this.#speechSynthesis.speak(utterance)
    return handle
  }

  cancel(): void {
    this.#speechSynthesis?.cancel()
  }

  beep(durationMs: number = DEFAULT_BEEP_DURATION_MS, freqHz: number = DEFAULT_BEEP_FREQ_HZ): void {
    const context = this.#ensureAudioContext()
    if (context.state === 'suspended') {
      // resume() can reject (closed context, or outside a gesture on some
      // platforms); the beep is simply silent then — never an unhandledrejection.
      context.resume().catch(() => {})
    }
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.frequency.value = freqHz
    gain.gain.value = BEEP_GAIN
    oscillator.connect(gain)
    gain.connect(context.destination)
    oscillator.start()
    oscillator.stop(context.currentTime + durationMs / 1000)
  }

  #refreshVoices(): void {
    this.#voices = this.#speechSynthesis?.getVoices() ?? []
    this.#defaultVoice = pickDefaultEnglishVoice(this.#voices)
  }
}

let singleton: AudioService | null = null

export function getAudioService(): AudioService {
  singleton ??= new AudioService()
  return singleton
}
