import { describe, expect, test } from 'vitest'
import type { AudioService } from '../audio/audio-service'
import type { Lap } from '../domain/types'
import {
  Announcer,
  computeAnnouncementRecords,
  formatLapAnnouncement,
  type Speaker,
} from './announcer'

function lap(n: number, durationMs: number, status: Lap['status'] = 'valid'): Lap {
  return { n, durationMs, completedAt: '2026-07-13T10:00:00Z', status }
}

const noRecords = { isSessionBestLap: false, isSessionBestThree: false }

describe('formatLapAnnouncement', () => {
  test('14.32 s → "14 3"', () => {
    expect(formatLapAnnouncement(lap(1, 14320), noRecords)).toBe('14 3')
  })

  test('rounds to the nearest tenth, half up: 14.35 s → "14 4"', () => {
    expect(formatLapAnnouncement(lap(1, 14350), noRecords)).toBe('14 4')
  })

  test('rounding carries into the seconds: 14.96 s → "15 0"', () => {
    expect(formatLapAnnouncement(lap(1, 14960), noRecords)).toBe('15 0')
  })

  test('just below the tenth boundary rounds down: 14.34 s → "14 3"', () => {
    expect(formatLapAnnouncement(lap(1, 14349), noRecords)).toBe('14 3')
  })

  test('sub-second lap: 0.94 s → "0 9"', () => {
    expect(formatLapAnnouncement(lap(1, 940), noRecords)).toBe('0 9')
  })

  test('session-best lap gets the "best" prefix', () => {
    expect(
      formatLapAnnouncement(lap(2, 14100), { isSessionBestLap: true, isSessionBestThree: false }),
    ).toBe('best 14 1')
  })

  test('session-best three gets the "best three" suffix', () => {
    expect(
      formatLapAnnouncement(lap(4, 14320), { isSessionBestLap: false, isSessionBestThree: true }),
    ).toBe('14 3 best three')
  })

  test('both records combine: "best 14 1 best three"', () => {
    expect(
      formatLapAnnouncement(lap(5, 14100), { isSessionBestLap: true, isSessionBestThree: true }),
    ).toBe('best 14 1 best three')
  })
})

describe('computeAnnouncementRecords', () => {
  function afterLaps(...durations: (number | [number, 'discarded'])[]) {
    const laps = durations.map((entry, index) =>
      typeof entry === 'number' ? lap(index + 1, entry) : lap(index + 1, entry[0], 'discarded'),
    )
    return computeAnnouncementRecords(laps, laps[laps.length - 1])
  }

  test('throws when newLap is not the last element', () => {
    const laps = [lap(1, 14000), lap(2, 13000)]
    expect(() => computeAnnouncementRecords(laps, laps[0])).toThrow(
      'newLap must be the last element',
    )
  })

  test('the first valid lap is NOT announced as best', () => {
    expect(afterLaps(14000)).toEqual(noRecords)
  })

  test('a lap faster than all previous valid laps is the session best', () => {
    expect(afterLaps(14000, 13000).isSessionBestLap).toBe(true)
  })

  test('a slower lap is not the session best', () => {
    expect(afterLaps(13000, 14000).isSessionBestLap).toBe(false)
  })

  test('a tie with the standing best is not announced', () => {
    expect(afterLaps(13000, 13000).isSessionBestLap).toBe(false)
  })

  test('discarded previous laps do not count as a standing best', () => {
    // The only previous lap is discarded, so this is effectively the first
    // valid lap: no announcement even though it beats the discarded time.
    expect(afterLaps([9000, 'discarded'], 14000).isSessionBestLap).toBe(false)
  })

  test('beating only a discarded lap but not the valid best is not best', () => {
    expect(afterLaps(13000, [9000, 'discarded'], 12000).isSessionBestLap).toBe(true)
    expect(afterLaps(13000, [9000, 'discarded'], 13500).isSessionBestLap).toBe(false)
  })

  test('the first-ever best-three window is NOT announced', () => {
    expect(afterLaps(14000, 14000, 14000).isSessionBestThree).toBe(false)
  })

  test('a window strictly beating the standing best three is announced', () => {
    const result = afterLaps(14000, 14000, 14000, 13000)
    expect(result.isSessionBestThree).toBe(true)
  })

  test('a window tying the standing best three is not announced', () => {
    expect(afterLaps(14000, 14000, 14000, 14000).isSessionBestThree).toBe(false)
  })

  test('a discard resets the running window: no announcement until a full new window beats the record', () => {
    expect(afterLaps(14000, 14000, 14000, [1, 'discarded'], 13000).isSessionBestThree).toBe(false)
    expect(
      afterLaps(14000, 14000, 14000, [1, 'discarded'], 13000, 13000).isSessionBestThree,
    ).toBe(false)
    expect(
      afterLaps(14000, 14000, 14000, [1, 'discarded'], 13000, 13000, 13000).isSessionBestThree,
    ).toBe(true)
  })

  test('best lap and best three can both fire on the same lap', () => {
    const result = afterLaps(14000, 14000, 14000, 13000)
    expect(result).toEqual({ isSessionBestLap: true, isSessionBestThree: true })
  })
})

class FakeSpeaker implements Speaker {
  readonly spoken: string[] = []
  readonly #settlers: (() => void)[] = []

  speak(text: string) {
    this.spoken.push(text)
    let settle!: () => void
    const settled = new Promise<void>((resolve) => (settle = resolve))
    this.#settlers.push(settle)
    return { settled }
  }

  async settleNext(): Promise<void> {
    const settle = this.#settlers.shift()
    if (!settle) throw new Error('nothing in flight to settle')
    settle()
    await Promise.resolve()
  }
}

class FakeScheduler {
  #nextId = 1
  readonly #timers = new Map<number, { fn: () => void; ms: number }>()

  readonly setTimeoutFn = (fn: () => void, ms: number): unknown => {
    const id = this.#nextId++
    this.#timers.set(id, { fn, ms })
    return id
  }

  readonly clearTimeoutFn = (handle: unknown): void => {
    this.#timers.delete(handle as number)
  }

  get pendingCount(): number {
    return this.#timers.size
  }

  get pendingMs(): number[] {
    return [...this.#timers.values()].map((timer) => timer.ms)
  }

  fireNext(): void {
    const first = this.#timers.entries().next()
    if (first.done) throw new Error('no pending timer to fire')
    const [id, timer] = first.value
    this.#timers.delete(id)
    timer.fn()
  }
}

function announcerWithScheduler(speaker: Speaker, settleTimeoutMs?: number) {
  const scheduler = new FakeScheduler()
  const announcer = new Announcer(speaker, {
    settleTimeoutMs,
    setTimeoutFn: scheduler.setTimeoutFn,
    clearTimeoutFn: scheduler.clearTimeoutFn,
  })
  return { announcer, scheduler }
}

describe('Announcer queue policy (skip-stale-enqueue-next)', () => {
  test('AudioService satisfies the Speaker seam structurally', () => {
    const acceptsAudioService = (service: AudioService): Speaker => service
    expect(acceptsAudioService).toBeTypeOf('function')
  })

  test('speaks immediately when nothing is in flight', () => {
    const speaker = new FakeSpeaker()
    const { announcer } = announcerWithScheduler(speaker)
    announcer.announce('14 3')
    expect(speaker.spoken).toEqual(['14 3'])
    expect(announcer.decisions).toEqual([{ text: '14 3', action: 'spoken-immediately' }])
  })

  test('queues while in flight and speaks the pending one on settle', async () => {
    const speaker = new FakeSpeaker()
    const { announcer } = announcerWithScheduler(speaker)
    announcer.announce('14 3')
    announcer.announce('13 9')
    expect(speaker.spoken).toEqual(['14 3'])
    await speaker.settleNext()
    expect(speaker.spoken).toEqual(['14 3', '13 9'])
    expect(announcer.decisions).toEqual([
      { text: '14 3', action: 'spoken-immediately' },
      { text: '13 9', action: 'queued' },
    ])
  })

  test('a newer announcement drops the stale pending one — only the newest is held', async () => {
    const speaker = new FakeSpeaker()
    const { announcer } = announcerWithScheduler(speaker)
    announcer.announce('one')
    announcer.announce('two')
    announcer.announce('three')
    announcer.announce('four')
    expect(speaker.spoken).toEqual(['one'])
    await speaker.settleNext()
    expect(speaker.spoken).toEqual(['one', 'four'])
    expect(announcer.decisions).toEqual([
      { text: 'one', action: 'spoken-immediately' },
      { text: 'two', action: 'queued' },
      { text: 'two', action: 'dropped-stale' },
      { text: 'three', action: 'queued' },
      { text: 'three', action: 'dropped-stale' },
      { text: 'four', action: 'queued' },
    ])
  })

  test('settle chain: pending speech is itself in flight until settled', async () => {
    const speaker = new FakeSpeaker()
    const { announcer } = announcerWithScheduler(speaker)
    announcer.announce('one')
    announcer.announce('two')
    await speaker.settleNext()
    announcer.announce('three')
    expect(speaker.spoken).toEqual(['one', 'two'])
    await speaker.settleNext()
    expect(speaker.spoken).toEqual(['one', 'two', 'three'])
    await speaker.settleNext()
    announcer.announce('four')
    expect(speaker.spoken).toEqual(['one', 'two', 'three', 'four'])
  })

  test('a rejecting speaker does not wedge the queue', async () => {
    const spoken: string[] = []
    const { announcer } = announcerWithScheduler({
      speak: (text) => {
        spoken.push(text)
        return { settled: Promise.reject(new Error('boom')) }
      },
    })
    announcer.announce('one')
    announcer.announce('two')
    await Promise.resolve()
    await Promise.resolve()
    expect(spoken).toEqual(['one', 'two'])
  })

  test('announceLap formats and routes through the policy', () => {
    const speaker = new FakeSpeaker()
    const { announcer } = announcerWithScheduler(speaker)
    announcer.announceLap(lap(1, 14320), noRecords)
    announcer.announceLap(lap(2, 14100), { isSessionBestLap: true, isSessionBestThree: false })
    expect(speaker.spoken).toEqual(['14 3'])
    expect(announcer.decisions).toEqual([
      { text: '14 3', action: 'spoken-immediately' },
      { text: 'best 14 1', action: 'queued' },
    ])
  })
})

describe('Announcer settle watchdog', () => {
  test('a wedged utterance times out: queue advances and the pending text speaks', () => {
    const speaker = new FakeSpeaker()
    const { announcer, scheduler } = announcerWithScheduler(speaker)
    announcer.announce('one')
    announcer.announce('two')
    expect(speaker.spoken).toEqual(['one'])
    scheduler.fireNext()
    expect(speaker.spoken).toEqual(['one', 'two'])
    expect(announcer.decisions).toEqual([
      { text: 'one', action: 'spoken-immediately' },
      { text: 'two', action: 'queued' },
      { text: 'one', action: 'settle-timeout' },
    ])
  })

  test('a LATE real settle after a timeout is a no-op', async () => {
    const speaker = new FakeSpeaker()
    const { announcer, scheduler } = announcerWithScheduler(speaker)
    announcer.announce('one')
    announcer.announce('two')
    scheduler.fireNext()
    expect(speaker.spoken).toEqual(['one', 'two'])
    // "one" finally settles for real — it must not also settle "two".
    await speaker.settleNext()
    announcer.announce('three')
    expect(speaker.spoken).toEqual(['one', 'two'])
    expect(announcer.decisions.at(-1)).toEqual({ text: 'three', action: 'queued' })
  })

  test('a timeout with nothing pending just clears the in-flight state', () => {
    const speaker = new FakeSpeaker()
    const { announcer, scheduler } = announcerWithScheduler(speaker)
    announcer.announce('one')
    scheduler.fireNext()
    announcer.announce('two')
    expect(speaker.spoken).toEqual(['one', 'two'])
    expect(announcer.decisions.at(-1)).toEqual({ text: 'two', action: 'spoken-immediately' })
  })

  test('normal settle clears the watchdog — no timer leaks', async () => {
    const speaker = new FakeSpeaker()
    const { announcer, scheduler } = announcerWithScheduler(speaker)
    announcer.announce('one')
    expect(scheduler.pendingCount).toBe(1)
    await speaker.settleNext()
    expect(scheduler.pendingCount).toBe(0)
    expect(announcer.decisions).toEqual([{ text: 'one', action: 'spoken-immediately' }])
  })

  test('the default timeout is 8000 ms, overridable per instance', () => {
    const defaulted = announcerWithScheduler(new FakeSpeaker())
    defaulted.announcer.announce('one')
    expect(defaulted.scheduler.pendingMs).toEqual([8000])

    const overridden = announcerWithScheduler(new FakeSpeaker(), 500)
    overridden.announcer.announce('one')
    expect(overridden.scheduler.pendingMs).toEqual([500])
  })

  test('a speaker that throws synchronously does not wedge the queue', () => {
    let throwOnce = true
    const speaker = new FakeSpeaker()
    const { announcer, scheduler } = announcerWithScheduler({
      speak: (text) => {
        if (throwOnce) {
          throwOnce = false
          throw new Error('speech engine gone')
        }
        return speaker.speak(text)
      },
    })
    announcer.announce('one')
    expect(speaker.spoken).toEqual([])
    announcer.announce('two')
    expect(speaker.spoken).toEqual(['two'])
    expect(scheduler.pendingCount).toBe(1)
    expect(announcer.decisions).toEqual([
      { text: 'one', action: 'spoken-immediately' },
      { text: 'one', action: 'speak-failed' },
      { text: 'two', action: 'spoken-immediately' },
    ])
  })
})

describe('Announcer reset', () => {
  test('reset drops the pending announcement; the in-flight settle then speaks nothing', async () => {
    const speaker = new FakeSpeaker()
    const { announcer, scheduler } = announcerWithScheduler(speaker)
    announcer.announce('one')
    announcer.announce('two')
    announcer.reset()
    await speaker.settleNext()
    expect(speaker.spoken).toEqual(['one'])
    expect(scheduler.pendingCount).toBe(0)
    announcer.announce('three')
    expect(speaker.spoken).toEqual(['one', 'three'])
  })

  test('reset when idle is a no-op', () => {
    const speaker = new FakeSpeaker()
    const { announcer } = announcerWithScheduler(speaker)
    announcer.reset()
    announcer.announce('one')
    expect(speaker.spoken).toEqual(['one'])
  })
})
