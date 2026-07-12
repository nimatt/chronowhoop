import { describe, expect, it } from 'vitest'
import {
  AudioService,
  type SpeechErrorEventLike,
  type SpeechSynthesisLike,
  type UtteranceLike,
  type VoiceLike,
} from './audio-service'
import {
  probeCancelThenSpeak,
  probeRapidBackToBackSpeech,
  probeSpeakAfterReturn,
} from './speech-probes'

class FakeUtterance implements UtteranceLike {
  rate = 1
  volume = 1
  voice: VoiceLike | null = null
  onstart: (() => void) | null = null
  onend: (() => void) | null = null
  onerror: ((event: SpeechErrorEventLike) => void) | null = null
  constructor(public text: string) {}
}

// Scriptable engine: tests decide, per spoken utterance, which lifecycle
// events fire (synchronously, with the fake clock advanced in between) — or
// none at all, simulating a wedged engine.
class ScriptedSynthesis implements SpeechSynthesisLike {
  spoken: FakeUtterance[] = []
  cancelCalls = 0
  onSpeak: (utterance: FakeUtterance, index: number) => void = () => {}
  onCancel: () => void = () => {}

  speak(utterance: UtteranceLike): void {
    const fake = utterance as FakeUtterance
    this.spoken.push(fake)
    this.onSpeak(fake, this.spoken.length - 1)
  }
  cancel(): void {
    this.cancelCalls++
    this.onCancel()
  }
  getVoices(): VoiceLike[] {
    return []
  }
  addEventListener(): void {}
}

function makeRig() {
  const synthesis = new ScriptedSynthesis()
  let time = 0
  const now = () => time
  const advance = (ms: number) => (time += ms)
  const service = new AudioService({
    speechSynthesis: synthesis,
    createUtterance: (text) => new FakeUtterance(text),
    createAudioContext: () => {
      throw new Error('probes must not touch the AudioContext')
    },
    now,
  })
  // Timeout races resolve immediately: promises of events that already fired
  // still win the race, anything unfired reads as timed out.
  const instantDelay = () => Promise.resolve()
  return { service, synthesis, advance, now, instantDelay }
}

function speakNormally(advance: (ms: number) => number) {
  return (utterance: FakeUtterance) => {
    advance(10)
    utterance.onstart?.()
    advance(200)
    utterance.onend?.()
  }
}

describe('probeRapidBackToBackSpeech', () => {
  it('reports ok with per-step delays and gaps when all utterances play', async () => {
    const { service, synthesis, advance, now, instantDelay } = makeRig()
    synthesis.onSpeak = speakNormally(advance)

    const result = await probeRapidBackToBackSpeech(service, { delay: instantDelay, now })

    expect(result.probe).toBe('rapid-back-to-back')
    expect(result.ok).toBe(true)
    expect(result.steps).toHaveLength(3)
    for (const step of result.steps) {
      expect(step).toMatchObject({
        startFired: true,
        endFired: true,
        errorFired: false,
        timedOut: false,
        startDelayMs: 10,
        durationMs: 200,
      })
    }
    expect(result.steps.map((step) => step.gapFromPreviousEndMs)).toEqual([null, 10, 10])
    expect(result.totalMs).toBe(630)
  })

  it('reports the error and fails when one utterance errors', async () => {
    const { service, synthesis, advance, now, instantDelay } = makeRig()
    synthesis.onSpeak = (utterance, index) => {
      if (index === 2) {
        utterance.onerror?.({ error: 'synthesis-failed' })
        return
      }
      speakNormally(advance)(utterance)
    }

    const result = await probeRapidBackToBackSpeech(service, { delay: instantDelay, now })

    expect(result.ok).toBe(false)
    expect(result.steps[2]).toMatchObject({
      startFired: false,
      endFired: false,
      errorFired: true,
      error: 'synthesis-failed',
      timedOut: false,
    })
  })

  it('marks utterances whose events never arrive as timed out instead of hanging', async () => {
    const { service, synthesis, advance, now, instantDelay } = makeRig()
    synthesis.onSpeak = (utterance, index) => {
      if (index === 0) speakNormally(advance)(utterance)
    }

    const result = await probeRapidBackToBackSpeech(service, { delay: instantDelay, now })

    expect(result.ok).toBe(false)
    expect(result.steps[0].timedOut).toBe(false)
    for (const step of result.steps.slice(1)) {
      expect(step).toMatchObject({ startFired: false, endFired: false, timedOut: true })
    }
  })
})

describe('probeCancelThenSpeak', () => {
  it('reports ok when the post-cancel utterance starts', async () => {
    const { service, synthesis, advance, now, instantDelay } = makeRig()
    synthesis.onSpeak = (utterance, index) => {
      advance(5)
      utterance.onstart?.()
      if (index === 1) {
        advance(100)
        utterance.onend?.()
      }
    }
    synthesis.onCancel = () => {
      advance(2)
      synthesis.spoken[0].onerror?.({ error: 'interrupted' })
    }

    const result = await probeCancelThenSpeak(service, { delay: instantDelay, now })

    expect(result.probe).toBe('cancel-then-speak')
    expect(result.ok).toBe(true)
    expect(result.detail).toBe('utterance spoken immediately after cancel() started normally')
    expect(synthesis.cancelCalls).toBe(1)
    expect(result.steps[0]).toMatchObject({
      startFired: true,
      errorFired: true,
      error: 'interrupted',
      timedOut: false,
    })
    expect(result.steps[1]).toMatchObject({
      startFired: true,
      endFired: true,
      startDelayMs: 5,
      timedOut: false,
    })
  })

  it('labels a pre-start error on the post-cancel utterance as a fast error, not a wedge', async () => {
    const { service, synthesis, advance, now, instantDelay } = makeRig()
    synthesis.onSpeak = (utterance, index) => {
      if (index === 0) {
        advance(5)
        utterance.onstart?.()
        return
      }
      advance(3)
      utterance.onerror?.({ error: 'not-allowed' })
    }
    synthesis.onCancel = () => synthesis.spoken[0].onerror?.({ error: 'canceled' })

    const result = await probeCancelThenSpeak(service, { delay: instantDelay, now })

    expect(result.ok).toBe(false)
    expect(result.detail).toBe(
      'post-cancel utterance settled without starting (fast error, not the wedge signature)',
    )
    expect(result.steps[1]).toMatchObject({
      startFired: false,
      errorFired: true,
      error: 'not-allowed',
      timedOut: false,
    })
  })

  it('fails with the started-but-errored detail when the post-cancel utterance errors mid-speech', async () => {
    const { service, synthesis, advance, now, instantDelay } = makeRig()
    synthesis.onSpeak = (utterance, index) => {
      advance(5)
      utterance.onstart?.()
      if (index === 1) {
        advance(50)
        utterance.onerror?.({ error: 'synthesis-failed' })
      }
    }
    synthesis.onCancel = () => synthesis.spoken[0].onerror?.({ error: 'canceled' })

    const result = await probeCancelThenSpeak(service, { delay: instantDelay, now })

    expect(result.ok).toBe(false)
    expect(result.detail).toBe('post-cancel utterance started but errored')
    expect(result.steps[1]).toMatchObject({
      startFired: true,
      endFired: false,
      errorFired: true,
      error: 'synthesis-failed',
      timedOut: false,
    })
  })

  it('fails with the mid-utterance wedge detail when the post-cancel utterance starts but never settles', async () => {
    const { service, synthesis, advance, now, instantDelay } = makeRig()
    synthesis.onSpeak = (utterance) => {
      advance(5)
      utterance.onstart?.()
    }
    synthesis.onCancel = () => synthesis.spoken[0].onerror?.({ error: 'canceled' })

    const result = await probeCancelThenSpeak(service, { delay: instantDelay, now })

    expect(result.ok).toBe(false)
    expect(result.detail).toBe(
      'post-cancel utterance started but never finished within the timeout (mid-utterance wedge signature)',
    )
    expect(result.steps[1]).toMatchObject({ startFired: true, endFired: false, timedOut: true })
  })

  it('reports the wedged-engine signature when the second utterance never starts', async () => {
    const { service, synthesis, advance, now, instantDelay } = makeRig()
    synthesis.onSpeak = (utterance, index) => {
      if (index === 0) {
        advance(5)
        utterance.onstart?.()
      }
    }
    synthesis.onCancel = () => synthesis.spoken[0].onerror?.({ error: 'canceled' })

    const result = await probeCancelThenSpeak(service, { delay: instantDelay, now })

    expect(result.ok).toBe(false)
    expect(result.detail).toContain('never started')
    expect(result.steps[1]).toMatchObject({ startFired: false, timedOut: true })
  })
})

describe('probeSpeakAfterReturn', () => {
  it('reports ok when speech starts without a fresh gesture', async () => {
    const { service, synthesis, advance, now, instantDelay } = makeRig()
    synthesis.onSpeak = speakNormally(advance)

    const result = await probeSpeakAfterReturn(service, { delay: instantDelay, now })

    expect(result.probe).toBe('speak-after-return')
    expect(result.ok).toBe(true)
    expect(result.steps[0]).toMatchObject({ startFired: true, endFired: true, startDelayMs: 10 })
  })

  it('fails with a re-prime hint when speech never starts', async () => {
    const { service, synthesis, now, instantDelay } = makeRig()
    synthesis.onSpeak = () => {}

    const result = await probeSpeakAfterReturn(service, { delay: instantDelay, now })

    expect(result.ok).toBe(false)
    expect(result.detail).toContain('re-prime')
    expect(result.steps[0]).toMatchObject({ startFired: false, timedOut: true })
  })

  it('fails with the mid-utterance wedge detail when speech starts but never settles', async () => {
    const { service, synthesis, advance, now, instantDelay } = makeRig()
    synthesis.onSpeak = (utterance) => {
      advance(10)
      utterance.onstart?.()
    }

    const result = await probeSpeakAfterReturn(service, { delay: instantDelay, now })

    expect(result.ok).toBe(false)
    expect(result.detail).toBe(
      'speech started after returning but never finished within the timeout (mid-utterance wedge signature)',
    )
    expect(result.steps[0]).toMatchObject({ startFired: true, endFired: false, timedOut: true })
  })

  it('fails with the started-but-errored detail when speech errors mid-utterance', async () => {
    const { service, synthesis, advance, now, instantDelay } = makeRig()
    synthesis.onSpeak = (utterance) => {
      advance(10)
      utterance.onstart?.()
      advance(50)
      utterance.onerror?.({ error: 'synthesis-failed' })
    }

    const result = await probeSpeakAfterReturn(service, { delay: instantDelay, now })

    expect(result.ok).toBe(false)
    expect(result.detail).toBe('speech started after returning but errored mid-utterance')
    expect(result.steps[0]).toMatchObject({
      startFired: true,
      endFired: false,
      errorFired: true,
      error: 'synthesis-failed',
      timedOut: false,
    })
  })

  it('fails when the utterance errors before starting', async () => {
    const { service, synthesis, now, instantDelay } = makeRig()
    synthesis.onSpeak = (utterance) => utterance.onerror?.({ error: 'not-allowed' })

    const result = await probeSpeakAfterReturn(service, { delay: instantDelay, now })

    expect(result.ok).toBe(false)
    expect(result.steps[0]).toMatchObject({
      startFired: false,
      errorFired: true,
      error: 'not-allowed',
      timedOut: false,
    })
  })
})
