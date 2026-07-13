// The never-block proof (plan 06 item 5): the canonical full-loop clip
// scenario runs three ways — no storage at all (baseline), MemoryStorage
// through a SessionPersister, and pathological storages (saves that hang
// forever / fail every time) through the same persister — and the observable
// timing behavior (crossing events, armed start, lap sequence, announcement
// decision log, what was spoken) must be BYTE-IDENTICAL across all runs:
// storage can only ever be a bystander to lap timing and speech.
//
// The whole scenario body is synchronous: persister calls are fire-and-forget
// inside the engine's onLap callback (before the announcement — see
// SessionRigHooks), so a hung save simply never settles while everything else
// proceeds. The MemoryStorage run additionally proves the data path: after
// flush, the stored session equals the engine's final session, discard
// included.

import { describe, expect, test } from 'vitest'
import type { CrossingEvent } from './detection/crossing-events'
import type { Session } from './domain/types'
import { courseFixture, createArmedSessionRig, runCanonicalClip } from './full-loop-rig'
import type { AnnounceDecision } from './announcer/announcer'
import { createSessionPersister, type SessionPersister } from './session/session-persister'
import { MemoryStorage } from './storage/memory-storage'
import { StorageError } from './storage/storage'

// Everything timing-observable about a run, deep-copied at capture time so
// later mutations (the discard) cannot blur the comparison.
interface RunOutcome {
  events: CrossingEvent[]
  armedStarts: number[]
  lapsAtArrival: { n: number; durationMs: number; status: string }[]
  decisions: AnnounceDecision[]
  spokenBeforeAnySettle: string[]
  finalLapStatuses: string[]
}

// The exact fly-screen call shape: sessionStarted at arm, sessionUpdated on
// every lap and on discard. Fully synchronous — no await anywhere in the
// scenario, which is itself half the proof.
function runScenario(makePersister?: () => SessionPersister): RunOutcome {
  const lapsAtArrival: RunOutcome['lapsAtArrival'] = []
  const persister = makePersister?.()
  const rig = createArmedSessionRig(courseFixture(), {
    onLap: (lap, session) => {
      lapsAtArrival.push({ n: lap.n, durationMs: lap.durationMs, status: lap.status })
      persister?.sessionUpdated(session)
    },
  })
  const armedSession = rig.engine.session
  if (armedSession === null) throw new Error('unreachable: rig arms the engine')
  persister?.sessionStarted(armedSession)

  const { events } = runCanonicalClip(rig)

  rig.engine.stop()
  rig.engine.discardLastLap()
  persister?.sessionUpdated(armedSession)

  return {
    events,
    armedStarts: [...rig.armedStarts],
    lapsAtArrival,
    decisions: [...rig.announcer.decisions],
    spokenBeforeAnySettle: [...rig.speaker.spoken],
    finalLapStatuses: armedSession.laps.map((lap) => lap.status),
  }
}

class HangingStorage extends MemoryStorage {
  saveSessionCalls = 0

  override saveSession(): Promise<void> {
    this.saveSessionCalls++
    return new Promise(() => {})
  }
}

class FailingStorage extends MemoryStorage {
  saveSessionCalls = 0

  override saveSession(): Promise<void> {
    this.saveSessionCalls++
    return Promise.reject(new StorageError('write-failed', 'simulated write failure'))
  }
}

describe('full loop with storage attached: writes never affect timing or speech', () => {
  test('lap events and announcement decisions are byte-identical across baseline, memory, hung, and failing storage', async () => {
    const baseline = runScenario()

    const memoryStorage = new MemoryStorage()
    let memoryPersister!: SessionPersister
    const withMemory = runScenario(() => {
      memoryPersister = createSessionPersister(memoryStorage)
      return memoryPersister
    })

    const hangingStorage = new HangingStorage()
    let hangingPersister!: SessionPersister
    const withHanging = runScenario(() => {
      hangingPersister = createSessionPersister(hangingStorage)
      return hangingPersister
    })

    const failingStorage = new FailingStorage()
    let failingPersister!: SessionPersister
    // Scheduler that never fires: a scheduled retry can never help the run.
    const withFailing = runScenario(() => {
      failingPersister = createSessionPersister(failingStorage, {
        scheduleFn: () => ({}),
        cancelFn: () => {},
      })
      return failingPersister
    })

    // The plan's proof, literally byte-identical: every observable timing
    // outcome serializes to the same bytes as the storage-free baseline.
    const baselineBytes = JSON.stringify(baseline)
    expect(JSON.stringify(withMemory)).toBe(baselineBytes)
    expect(JSON.stringify(withHanging)).toBe(baselineBytes)
    expect(JSON.stringify(withFailing)).toBe(baselineBytes)

    // Sanity: the baseline saw the canonical scenario (3 laps, one discarded,
    // "14 0" still in flight when the run ends).
    expect(baseline.lapsAtArrival.map((lap) => lap.durationMs)).toEqual([14000, 13000, 16000])
    expect(baseline.finalLapStatuses).toEqual(['valid', 'valid', 'discarded'])
    expect(baseline.spokenBeforeAnySettle).toEqual(['14 0'])
    expect(baseline.decisions.map((decision) => decision.action)).toEqual([
      'spoken-immediately',
      'queued',
      'dropped-stale',
      'queued',
    ])

    // The pathological storages were really exercised, not silently bypassed:
    // the hung storage swallowed the arm-time save and left everything
    // pending; the failing storage failed every attempt it was given.
    expect(hangingStorage.saveSessionCalls).toBe(1)
    expect(hangingPersister.state.pending).toBe(true)
    await Promise.resolve()
    expect(failingStorage.saveSessionCalls).toBeGreaterThanOrEqual(1)
    await drainMicrotasks()
    expect(failingPersister.state.lastError?.kind).toBe('write-failed')

    // The healthy path also persisted the data: after flush, the stored
    // session equals the engine's final session, discard included.
    await memoryPersister.flush()
    expect(memoryPersister.state.lastError).toBeUndefined()
    expect(memoryPersister.state.savedLapCount).toBe(3)
    const stored: Session = await memoryStorage.loadSession('session-full-loop')
    expect(stored.laps.map((lap) => lap.status)).toEqual(['valid', 'valid', 'discarded'])
    expect(stored.laps.map((lap) => lap.durationMs)).toEqual([14000, 13000, 16000])
    expect(stored.courseId).toBe('course-full-loop')
  })
})

async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}
