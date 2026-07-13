import { describe, expect, test } from 'vitest'
import type { Lap, Session } from '../domain/types'
import { bestLap, bestThreeConsecutive, courseRecords, sessionRecords } from './records'

function lap(n: number, durationMs: number, status: Lap['status'] = 'valid'): Lap {
  return { n, durationMs, completedAt: '2026-07-13T10:00:00Z', status }
}

function laps(...durations: (number | [number, 'discarded'])[]): Lap[] {
  return durations.map((entry, index) =>
    typeof entry === 'number' ? lap(index + 1, entry) : lap(index + 1, entry[0], 'discarded'),
  )
}

function session(id: string, sessionLaps: Lap[]): Session {
  return {
    id,
    courseId: 'course-1',
    startedAt: '2026-07-13T10:00:00Z',
    note: '',
    detectionConfig: {} as Session['detectionConfig'],
    laps: sessionLaps,
  }
}

describe('bestLap', () => {
  test('returns undefined for no laps', () => {
    expect(bestLap([])).toBeUndefined()
  })

  test('returns undefined when all laps are discarded', () => {
    expect(bestLap(laps([14000, 'discarded'], [13000, 'discarded']))).toBeUndefined()
  })

  test('returns the minimum-duration valid lap, ignoring faster discarded laps', () => {
    const list = laps(14320, [9000, 'discarded'], 13980, 15100)
    expect(bestLap(list)).toBe(list[2])
  })

  test('tie: the first occurrence wins', () => {
    const list = laps(13980, 14320, 13980)
    expect(bestLap(list)).toBe(list[0])
  })

  test('single valid lap is the best lap', () => {
    const list = laps(14320)
    expect(bestLap(list)).toBe(list[0])
  })
})

describe('bestThreeConsecutive', () => {
  test('returns undefined for empty and for fewer than 3 valid laps', () => {
    expect(bestThreeConsecutive([])).toBeUndefined()
    expect(bestThreeConsecutive(laps(14000, 13000))).toBeUndefined()
  })

  test('returns undefined when 3 valid laps exist but never consecutively', () => {
    const list = laps(14000, [1, 'discarded'], 13000, [1, 'discarded'], 12000)
    expect(bestThreeConsecutive(list)).toBeUndefined()
  })

  test('returns undefined when all laps are discarded', () => {
    const list = laps([14000, 'discarded'], [13000, 'discarded'], [12000, 'discarded'])
    expect(bestThreeConsecutive(list)).toBeUndefined()
  })

  test('exactly 3 valid laps form the only window', () => {
    const list = laps(14000, 13000, 15000)
    expect(bestThreeConsecutive(list)).toEqual({
      laps: [list[0], list[1], list[2]],
      totalMs: 42000,
    })
  })

  test('picks the minimum-sum window among all sliding windows', () => {
    const list = laps(15000, 14000, 13000, 12000, 16000)
    const best = bestThreeConsecutive(list)
    expect(best?.laps).toEqual([list[1], list[2], list[3]])
    expect(best?.totalMs).toBe(39000)
  })

  test('a discarded lap breaks consecutiveness: windows cannot span it', () => {
    // Fastest three durations sit around the discard; the only legal windows
    // are before it and after it.
    const list = laps(15000, 12000, 11000, [1, 'discarded'], 10000, 15000, 15000)
    const best = bestThreeConsecutive(list)
    expect(best?.laps).toEqual([list[0], list[1], list[2]])
    expect(best?.totalMs).toBe(38000)
  })

  test('window after a discard is found when it beats the window before', () => {
    const list = laps(15000, 15000, 15000, [1, 'discarded'], 12000, 12000, 12000)
    const best = bestThreeConsecutive(list)
    expect(best?.laps).toEqual([list[4], list[5], list[6]])
    expect(best?.totalMs).toBe(36000)
  })

  test('tie between windows: the first occurrence wins', () => {
    const list = laps(14000, 13000, 12000, 14000, 13000, 12000)
    // Windows [0..2] and [3..5] both total 39000; [1..3] and [2..4] also
    // total 39000. First wins.
    const best = bestThreeConsecutive(list)
    expect(best?.laps).toEqual([list[0], list[1], list[2]])
  })
})

describe('sessionRecords', () => {
  test('returns both records together', () => {
    const list = laps(14000, 13000, 15000)
    expect(sessionRecords(list)).toEqual({
      bestLap: list[1],
      bestThreeConsecutive: { laps: [list[0], list[1], list[2]], totalMs: 42000 },
    })
  })

  test('both undefined on empty input', () => {
    expect(sessionRecords([])).toEqual({
      bestLap: undefined,
      bestThreeConsecutive: undefined,
    })
  })
})

describe('courseRecords', () => {
  test('empty session list yields no records', () => {
    expect(courseRecords([])).toEqual({
      bestLap: undefined,
      bestThreeConsecutive: undefined,
    })
  })

  test('single session matches sessionRecords', () => {
    const list = laps(14000, 13000, 15000)
    expect(courseRecords([session('s1', list)])).toEqual(sessionRecords(list))
  })

  test('best lap is the global minimum across all sessions', () => {
    const a = laps(14000, 13000)
    const b = laps(12500, 15000)
    expect(courseRecords([session('s1', a), session('s2', b)]).bestLap).toBe(b[0])
  })

  test('best-three windows never span sessions', () => {
    // 2 valid laps in one session + 1 in the next never form a window.
    const a = laps(10000, 10000)
    const b = laps(10000, 20000, 20000)
    const records = courseRecords([session('s1', a), session('s2', b)])
    expect(records.bestThreeConsecutive?.laps).toEqual([b[0], b[1], b[2]])
    expect(records.bestThreeConsecutive?.totalMs).toBe(50000)
  })

  test('best three picks the minimum window across sessions', () => {
    const a = laps(14000, 14000, 14000)
    const b = laps(13000, 13000, 13000)
    const records = courseRecords([session('s1', a), session('s2', b)])
    expect(records.bestThreeConsecutive?.totalMs).toBe(39000)
    expect(records.bestThreeConsecutive?.laps).toEqual([b[0], b[1], b[2]])
  })

  test('cross-session ties: the earlier session wins', () => {
    const a = laps(13000)
    const b = laps(13000)
    expect(courseRecords([session('s1', a), session('s2', b)]).bestLap).toBe(a[0])
  })

  test('cross-session best-three ties: the earlier session wins', () => {
    // Both windows total 39000 but with different splits, so the assertion
    // can only pass on the earlier session's window.
    const a = laps(13000, 13000, 13000)
    const b = laps(12000, 13000, 14000)
    const records = courseRecords([session('s1', a), session('s2', b)])
    expect(records.bestThreeConsecutive?.totalMs).toBe(39000)
    expect(records.bestThreeConsecutive?.laps).toEqual([a[0], a[1], a[2]])
  })
})
