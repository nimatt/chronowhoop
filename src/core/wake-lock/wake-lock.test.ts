import { describe, expect, it } from 'vitest'
import {
  createWakeLockService,
  type VisibilityDocumentLike,
  type WakeLockApiLike,
  type WakeLockSentinelLike,
  type WakeLockTransition,
} from './wake-lock'

class FakeSentinel implements WakeLockSentinelLike {
  released = false
  private listeners: Array<() => void> = []

  addEventListener(_type: 'release', listener: () => void): void {
    this.listeners.push(listener)
  }

  removeEventListener(_type: 'release', listener: () => void): void {
    this.listeners = this.listeners.filter((registered) => registered !== listener)
  }

  // The real API fires 'release' on explicit release() too; mirroring that
  // verifies the service does not double-log explicit releases.
  async release(): Promise<void> {
    this.fireRelease()
  }

  releaseFromPlatform(): void {
    this.fireRelease()
  }

  private fireRelease(): void {
    this.released = true
    for (const listener of [...this.listeners]) listener()
  }
}

class FakeWakeLock implements WakeLockApiLike {
  sentinels: FakeSentinel[] = []
  requestCount = 0
  rejectWith: Error | null = null
  private deferredResolvers: Array<() => void> = []
  deferred = false

  async request(): Promise<WakeLockSentinelLike> {
    this.requestCount += 1
    if (this.rejectWith) throw this.rejectWith
    const sentinel = new FakeSentinel()
    this.sentinels.push(sentinel)
    if (!this.deferred) return sentinel
    return new Promise((resolve) => {
      this.deferredResolvers.push(() => resolve(sentinel))
    })
  }

  resolveDeferred(): void {
    const resolvers = this.deferredResolvers
    this.deferredResolvers = []
    for (const resolve of resolvers) resolve()
  }

  get lastSentinel(): FakeSentinel {
    const sentinel = this.sentinels[this.sentinels.length - 1]
    if (!sentinel) throw new Error('no sentinel was requested')
    return sentinel
  }
}

class FakeDocument implements VisibilityDocumentLike {
  visibilityState: 'visible' | 'hidden' = 'visible'
  listeners = new Set<() => void>()

  addEventListener(_type: 'visibilitychange', listener: () => void): void {
    this.listeners.add(listener)
  }

  removeEventListener(_type: 'visibilitychange', listener: () => void): void {
    this.listeners.delete(listener)
  }

  setVisibility(next: 'visible' | 'hidden'): void {
    this.visibilityState = next
    for (const listener of [...this.listeners]) listener()
  }
}

function makeService(overrides: { wakeLock?: FakeWakeLock | undefined } = {}) {
  const wakeLock = 'wakeLock' in overrides ? overrides.wakeLock : new FakeWakeLock()
  const doc = new FakeDocument()
  const transitions: WakeLockTransition[] = []
  let tick = 0
  const service = createWakeLockService({
    wakeLock,
    visibilityDocument: doc,
    now: () => ++tick,
    onTransition: (transition) => transitions.push(transition),
  })
  return { service, wakeLock, doc, transitions }
}

function states(transitions: readonly WakeLockTransition[]): string[] {
  return transitions.map((transition) => transition.state)
}

describe('createWakeLockService', () => {
  it('reports unsupported when the API is missing and stays inert', async () => {
    const { service, doc, transitions } = makeService({ wakeLock: undefined })
    expect(service.state).toBe('unsupported')
    expect(doc.listeners.size).toBe(0)

    await service.acquire()
    await service.release()
    expect(service.state).toBe('unsupported')
    expect(states(transitions)).toEqual(['unsupported'])
  })

  it('acquires through acquiring to active and logs timestamps from the injected clock', async () => {
    const { service, transitions } = makeService()
    expect(service.state).toBe('released')

    await service.acquire()
    expect(service.state).toBe('active')
    expect(states(transitions)).toEqual(['released', 'acquiring', 'active'])
    expect(transitions.map((transition) => transition.at)).toEqual([1, 2, 3])
  })

  it('makes acquire idempotent while active and while a request is in flight', async () => {
    const { service, wakeLock, transitions } = makeService()
    wakeLock!.deferred = true

    const first = service.acquire()
    const second = service.acquire()
    wakeLock!.resolveDeferred()
    await Promise.all([first, second])
    await service.acquire()

    expect(wakeLock!.requestCount).toBe(1)
    expect(states(transitions)).toEqual(['released', 'acquiring', 'active'])
  })

  it('does not issue a duplicate request when visibility flaps during a deferred acquire', async () => {
    const { service, wakeLock, doc } = makeService()
    wakeLock!.deferred = true

    const acquiring = service.acquire()
    doc.setVisibility('hidden')
    doc.setVisibility('visible')
    wakeLock!.resolveDeferred()
    await acquiring

    expect(wakeLock!.requestCount).toBe(1)
    expect(service.state).toBe('active')
    expect(wakeLock!.sentinels).toHaveLength(1)
    expect(wakeLock!.lastSentinel.released).toBe(false)
  })

  it('releases explicitly exactly once, marking the source', async () => {
    const { service, wakeLock, transitions } = makeService()
    await service.acquire()

    await service.release()
    await service.release()

    expect(wakeLock!.lastSentinel.released).toBe(true)
    expect(service.state).toBe('released')
    const last = transitions[transitions.length - 1]
    expect(last).toMatchObject({ state: 'released', releaseSource: 'explicit' })
    expect(states(transitions)).toEqual(['released', 'acquiring', 'active', 'released'])
  })

  it('records a platform-initiated release from the sentinel event', async () => {
    const { service, wakeLock, transitions } = makeService()
    await service.acquire()

    wakeLock!.lastSentinel.releaseFromPlatform()

    expect(service.state).toBe('released')
    const last = transitions[transitions.length - 1]
    expect(last).toMatchObject({ state: 'released', releaseSource: 'platform' })
  })

  it('reacquires on visible when the lock was held at hide, logging the reacquisition', async () => {
    const { service, wakeLock, doc, transitions } = makeService()
    await service.acquire()

    doc.setVisibility('hidden')
    wakeLock!.lastSentinel.releaseFromPlatform()
    doc.setVisibility('visible')
    await service.acquire()

    expect(wakeLock!.requestCount).toBe(2)
    expect(service.state).toBe('active')
    const reacquiring = transitions.find(
      (transition) =>
        transition.state === 'acquiring' && transition.detail?.includes('reacquire'),
    )
    expect(reacquiring).toBeDefined()
  })

  it('does not reacquire on visible after an explicit release', async () => {
    const { service, wakeLock, doc } = makeService()
    await service.acquire()
    await service.release()

    doc.setVisibility('hidden')
    doc.setVisibility('visible')

    expect(wakeLock!.requestCount).toBe(1)
    expect(service.state).toBe('released')
  })

  it('turns a rejected request into a failed state with the error in the log', async () => {
    const { service, wakeLock, transitions } = makeService()
    const rejection = new Error('page is not visible')
    rejection.name = 'NotAllowedError'
    wakeLock!.rejectWith = rejection

    await service.acquire()

    expect(service.state).toBe('failed')
    const last = transitions[transitions.length - 1]
    expect(last?.detail).toContain('NotAllowedError')
    expect(last?.detail).toContain('page is not visible')
  })

  it('retries on visible after a rejected acquire, since intent was to hold', async () => {
    const { service, wakeLock, doc } = makeService()
    const rejection = new Error('backgrounded')
    rejection.name = 'NotAllowedError'
    wakeLock!.rejectWith = rejection
    await service.acquire()
    expect(service.state).toBe('failed')

    wakeLock!.rejectWith = null
    doc.setVisibility('hidden')
    doc.setVisibility('visible')
    await service.acquire()

    expect(service.state).toBe('active')
    expect(wakeLock!.requestCount).toBe(2)
  })

  it('releases a lock granted after release() was called mid-acquisition', async () => {
    const { service, wakeLock, transitions } = makeService()
    wakeLock!.deferred = true

    const acquiring = service.acquire()
    const releasing = service.release()
    wakeLock!.resolveDeferred()
    await Promise.all([acquiring, releasing])

    expect(wakeLock!.lastSentinel.released).toBe(true)
    expect(service.state).toBe('released')
    const last = transitions[transitions.length - 1]
    expect(last).toMatchObject({ state: 'released', releaseSource: 'explicit' })
  })

  it('dispose releases the lock, unhooks visibility, and disables further use', async () => {
    const { service, wakeLock, doc } = makeService()
    await service.acquire()

    await service.dispose()
    await service.dispose()

    expect(wakeLock!.lastSentinel.released).toBe(true)
    expect(service.state).toBe('released')
    expect(doc.listeners.size).toBe(0)

    doc.setVisibility('hidden')
    doc.setVisibility('visible')
    await service.acquire()
    expect(wakeLock!.requestCount).toBe(1)
  })

  it('emits the initial state synchronously during creation', () => {
    const seen: WakeLockTransition[] = []
    createWakeLockService({
      wakeLock: new FakeWakeLock(),
      visibilityDocument: new FakeDocument(),
      now: () => 7,
      onTransition: (transition) => seen.push(transition),
    })

    expect(seen).toEqual([{ at: 7, state: 'released' }])
  })
})
