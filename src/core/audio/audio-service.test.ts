import { describe, expect, it } from 'vitest'
import {
  AudioService,
  DEFAULT_SPEECH_RATE,
  pickDefaultEnglishVoice,
  type AudioContextLike,
  type GainLike,
  type OscillatorLike,
  type SpeechErrorEventLike,
  type SpeechLifecycleEvent,
  type SpeechSynthesisLike,
  type UtteranceLike,
  type VoiceLike,
} from './audio-service'

class FakeUtterance implements UtteranceLike {
  rate = 1
  volume = 1
  voice: VoiceLike | null = null
  onstart: (() => void) | null = null
  onend: (() => void) | null = null
  onerror: ((event: SpeechErrorEventLike) => void) | null = null
  constructor(public text: string) {}
}

class FakeSpeechSynthesis implements SpeechSynthesisLike {
  spoken: FakeUtterance[] = []
  cancelCalls = 0
  #voices: VoiceLike[] = []
  #listeners: (() => void)[] = []

  speak(utterance: UtteranceLike): void {
    this.spoken.push(utterance as FakeUtterance)
  }
  cancel(): void {
    this.cancelCalls++
  }
  getVoices(): VoiceLike[] {
    return this.#voices
  }
  addEventListener(_type: 'voiceschanged', listener: () => void): void {
    this.#listeners.push(listener)
  }
  announceVoices(voices: VoiceLike[]): void {
    this.#voices = voices
    for (const listener of this.#listeners) listener()
  }
}

class FakeOscillator implements OscillatorLike {
  frequency = { value: 0 }
  connectedTo: unknown = null
  started = false
  stoppedAt: number | null = null
  connect(destination: unknown): unknown {
    this.connectedTo = destination
    return destination
  }
  start(): void {
    this.started = true
  }
  stop(when?: number): void {
    this.stoppedAt = when ?? null
  }
}

class FakeGain implements GainLike {
  gain = { value: 1 }
  connectedTo: unknown = null
  connect(destination: unknown): unknown {
    this.connectedTo = destination
    return destination
  }
}

class FakeAudioContext implements AudioContextLike {
  state = 'suspended'
  currentTime = 10
  destination = { name: 'destination' }
  resumeCalls = 0
  failResumesRemaining = 0
  oscillators: FakeOscillator[] = []
  gains: FakeGain[] = []

  async resume(): Promise<void> {
    this.resumeCalls++
    if (this.failResumesRemaining > 0) {
      this.failResumesRemaining--
      throw new Error('resume blocked')
    }
    this.state = 'running'
  }
  createOscillator(): FakeOscillator {
    const oscillator = new FakeOscillator()
    this.oscillators.push(oscillator)
    return oscillator
  }
  createGain(): FakeGain {
    const gain = new FakeGain()
    this.gains.push(gain)
    return gain
  }
}

function voice(name: string, lang: string, opts: { local?: boolean; def?: boolean } = {}): VoiceLike {
  return { name, lang, localService: opts.local ?? false, default: opts.def ?? false }
}

function makeService() {
  const synthesis = new FakeSpeechSynthesis()
  const context = new FakeAudioContext()
  let time = 0
  let contextsCreated = 0
  const service = new AudioService({
    speechSynthesis: synthesis,
    createUtterance: (text) => new FakeUtterance(text),
    createAudioContext: () => {
      contextsCreated++
      return context
    },
    now: () => time,
  })
  return {
    service,
    synthesis,
    context,
    advance: (ms: number) => (time += ms),
    contextsCreated: () => contextsCreated,
  }
}

describe('primeOnGesture', () => {
  it('creates and resumes the AudioContext and speaks a zero-volume unlock utterance', async () => {
    const { service, synthesis, context } = makeService()
    expect(service.primed).toBe(false)

    await service.primeOnGesture()

    expect(service.primed).toBe(true)
    expect(context.resumeCalls).toBe(1)
    expect(context.state).toBe('running')
    expect(synthesis.spoken).toHaveLength(1)
    expect(synthesis.spoken[0].text).toBe('')
    expect(synthesis.spoken[0].volume).toBe(0)
  })

  it('is idempotent: repeat calls reuse the same attempt and prime once', async () => {
    const { service, synthesis, context, contextsCreated } = makeService()
    const first = service.primeOnGesture()
    const second = service.primeOnGesture()
    expect(second).toBe(first)
    await first

    await service.primeOnGesture()
    expect(contextsCreated()).toBe(1)
    expect(context.resumeCalls).toBe(1)
    expect(synthesis.spoken).toHaveLength(1)
  })

  it('does not resume a context that is already running', async () => {
    const { service, context } = makeService()
    context.state = 'running'
    await service.primeOnGesture()
    expect(context.resumeCalls).toBe(0)
    expect(service.primed).toBe(true)
  })

  it('stays unprimed on failure and lets a later gesture retry', async () => {
    const { service, context, contextsCreated } = makeService()
    context.failResumesRemaining = 1

    await expect(service.primeOnGesture()).rejects.toThrow('resume blocked')
    expect(service.primed).toBe(false)

    await service.primeOnGesture()
    expect(service.primed).toBe(true)
    expect(contextsCreated()).toBe(1)
    expect(context.resumeCalls).toBe(2)
  })
})

describe('voice handling', () => {
  it('captures voices that arrive via a late voiceschanged event', () => {
    const { service, synthesis } = makeService()
    expect(service.voices).toEqual([])
    expect(service.defaultVoice).toBeNull()

    const voices = [voice('Daniel', 'en-GB', { local: true })]
    synthesis.announceVoices(voices)

    expect(service.voices).toEqual(voices)
    expect(service.defaultVoice).toEqual(voices[0])
  })

  it('re-picks the default voice on every voiceschanged', () => {
    const { service, synthesis } = makeService()
    synthesis.announceVoices([voice('Remote', 'en-US')])
    expect(service.defaultVoice?.name).toBe('Remote')

    synthesis.announceVoices([voice('Remote', 'en-US'), voice('Local', 'en-US', { local: true })])
    expect(service.defaultVoice?.name).toBe('Local')
  })
})

describe('pickDefaultEnglishVoice', () => {
  it('prefers a local default English voice over other English voices', () => {
    const best = voice('LocalDefault', 'en-US', { local: true, def: true })
    const picked = pickDefaultEnglishVoice([
      voice('Remote', 'en-US'),
      voice('LocalOnly', 'en-AU', { local: true }),
      best,
      voice('DefaultOnly', 'en-GB', { def: true }),
    ])
    expect(picked).toEqual(best)
  })

  it('prefers local over platform-default when no voice is both', () => {
    const local = voice('LocalOnly', 'en-AU', { local: true })
    const picked = pickDefaultEnglishVoice([voice('DefaultOnly', 'en-GB', { def: true }), local])
    expect(picked).toEqual(local)
  })

  it('never picks a non-English voice, even a local default one', () => {
    expect(
      pickDefaultEnglishVoice([voice('Amelie', 'fr-FR', { local: true, def: true })]),
    ).toBeNull()
  })

  it('falls back to any English voice', () => {
    const only = voice('Remote', 'en-IN')
    expect(pickDefaultEnglishVoice([voice('Amelie', 'fr-FR', { local: true }), only])).toEqual(only)
  })
})

describe('speak', () => {
  it('applies the default elevated rate and full volume', () => {
    const { service, synthesis } = makeService()
    service.speak('twelve four')
    expect(synthesis.spoken[0].rate).toBe(DEFAULT_SPEECH_RATE)
    expect(synthesis.spoken[0].volume).toBe(1)
  })

  it('honours explicit rate, volume, and voice options', () => {
    const { service, synthesis } = makeService()
    const custom = voice('Custom', 'en-US')
    service.speak('hi', { rate: 0.8, volume: 0.5, voice: custom })
    expect(synthesis.spoken[0].rate).toBe(0.8)
    expect(synthesis.spoken[0].volume).toBe(0.5)
    expect(synthesis.spoken[0].voice).toEqual(custom)
  })

  it('uses the picked default voice when none is given', () => {
    const { service, synthesis } = makeService()
    const en = voice('Daniel', 'en-GB', { local: true })
    synthesis.announceVoices([en])
    service.speak('hi')
    expect(synthesis.spoken[0].voice).toEqual(en)
  })

  it('emits queued/start/end lifecycle events with clock timestamps', async () => {
    const { service, synthesis, advance } = makeService()
    const events: SpeechLifecycleEvent[] = []
    service.onEvent((event) => events.push(event))

    advance(100)
    const handle = service.speak('twelve four')
    advance(20)
    synthesis.spoken[0].onstart?.()
    advance(780)
    synthesis.spoken[0].onend?.()
    await handle.settled

    expect(events).toEqual([
      { utteranceId: handle.id, text: 'twelve four', type: 'queued', timestamp: 100 },
      { utteranceId: handle.id, text: 'twelve four', type: 'start', timestamp: 120 },
      { utteranceId: handle.id, text: 'twelve four', type: 'end', timestamp: 900 },
    ])
    expect(handle.queuedAt).toBe(100)
    expect(handle.startedAt).toBe(120)
    expect(handle.endedAt).toBe(900)
    expect(handle.error).toBeNull()
  })

  it('reports the error event and message on failure', async () => {
    const { service, synthesis, advance } = makeService()
    const events: SpeechLifecycleEvent[] = []
    service.onEvent((event) => events.push(event))

    const handle = service.speak('hi')
    advance(50)
    synthesis.spoken[0].onerror?.({ error: 'interrupted' })
    await handle.settled

    expect(handle.error).toBe('interrupted')
    expect(handle.startedAt).toBeNull()
    expect(handle.endedAt).toBe(50)
    expect(events.at(-1)).toEqual({
      utteranceId: handle.id,
      text: 'hi',
      type: 'error',
      timestamp: 50,
      error: 'interrupted',
    })
  })

  it('resolves started at settle time when an utterance errors before starting', async () => {
    const { service, synthesis } = makeService()
    const handle = service.speak('hi')
    synthesis.spoken[0].onerror?.({ error: 'not-allowed' })

    await handle.started
    await handle.settled

    expect(handle.startedAt).toBeNull()
    expect(handle.error).toBe('not-allowed')
  })

  it('resolves started at settle time when an utterance ends without ever starting', async () => {
    const { service, synthesis } = makeService()
    const handle = service.speak('hi')
    synthesis.spoken[0].onend?.()

    await handle.started
    await handle.settled

    expect(handle.startedAt).toBeNull()
    expect(handle.error).toBeNull()
  })

  it('retains in-flight utterances strongly until end or error fires', () => {
    const { service, synthesis } = makeService()
    service.speak('one')
    service.speak('two')
    expect(service.pendingUtteranceCount).toBe(2)

    synthesis.spoken[0].onend?.()
    expect(service.pendingUtteranceCount).toBe(1)

    synthesis.spoken[1].onerror?.({ error: 'canceled' })
    expect(service.pendingUtteranceCount).toBe(0)
  })

  it('keeps retaining an utterance whose engine never fires a terminal event', () => {
    const { service, synthesis } = makeService()
    service.speak('wedged')
    synthesis.spoken[0].onstart?.()
    expect(service.pendingUtteranceCount).toBe(1)
  })

  it('stops notifying after unsubscribe', () => {
    const { service } = makeService()
    const events: SpeechLifecycleEvent[] = []
    const unsubscribe = service.onEvent((event) => events.push(event))
    service.speak('one')
    unsubscribe()
    service.speak('two')
    expect(events.map((event) => event.text)).toEqual(['one'])
  })

  it('settles immediately with an error when speechSynthesis is unavailable', async () => {
    const service = new AudioService({
      speechSynthesis: undefined,
      createUtterance: (text) => new FakeUtterance(text),
      createAudioContext: () => new FakeAudioContext(),
      now: () => 42,
    })
    const events: SpeechLifecycleEvent[] = []
    service.onEvent((event) => events.push(event))

    const handle = service.speak('hi')
    await handle.started
    await handle.settled

    expect(handle.startedAt).toBeNull()
    expect(handle.error).toBe('speechSynthesis is not available')
    expect(events.map((event) => event.type)).toEqual(['queued', 'error'])
    expect(service.pendingUtteranceCount).toBe(0)
  })
})

describe('cancel', () => {
  it('forwards to speechSynthesis.cancel', () => {
    const { service, synthesis } = makeService()
    service.cancel()
    expect(synthesis.cancelCalls).toBe(1)
  })

  it('preserves in-flight retention; only the utterance terminal event releases it', () => {
    const { service, synthesis } = makeService()
    service.speak('canceled mid-flight')
    expect(service.pendingUtteranceCount).toBe(1)

    service.cancel()
    expect(service.pendingUtteranceCount).toBe(1)

    synthesis.spoken[0].onerror?.({ error: 'canceled' })
    expect(service.pendingUtteranceCount).toBe(0)
  })
})

describe('beep', () => {
  it('plays an oscillator through a gain into the destination', () => {
    const { service, context } = makeService()
    service.beep(200, 440)

    const [oscillator] = context.oscillators
    const [gain] = context.gains
    expect(oscillator.frequency.value).toBe(440)
    expect(oscillator.connectedTo).toBe(gain)
    expect(gain.connectedTo).toBe(context.destination)
    expect(oscillator.started).toBe(true)
    expect(oscillator.stoppedAt).toBeCloseTo(context.currentTime + 0.2)
  })

  it('uses the default short high beep when called without arguments', () => {
    const { service, context } = makeService()
    service.beep()
    expect(context.oscillators[0].frequency.value).toBe(1000)
    expect(context.oscillators[0].stoppedAt).toBeCloseTo(context.currentTime + 0.08)
  })

  it('handles a rejected resume without an unhandled rejection and still schedules the beep', async () => {
    const { service, context } = makeService()
    context.failResumesRemaining = 1

    service.beep()
    await Promise.resolve()
    await Promise.resolve()

    expect(context.resumeCalls).toBe(1)
    expect(context.oscillators[0].started).toBe(true)
  })

  it('creates the context lazily and requests a resume when suspended', () => {
    const { service, context, contextsCreated } = makeService()
    expect(contextsCreated()).toBe(0)
    service.beep()
    expect(contextsCreated()).toBe(1)
    expect(context.resumeCalls).toBe(1)
  })
})
