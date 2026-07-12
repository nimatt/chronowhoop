export type WakeLockState = 'unsupported' | 'released' | 'acquiring' | 'active' | 'failed'

export type WakeLockReleaseSource = 'explicit' | 'platform'

export interface WakeLockTransition {
  /** From the injected clock; defaults to performance.now(), the same base as
   *  frame-loop and device-loss timestamps, so /diag events correlate. */
  at: number
  state: WakeLockState
  releaseSource?: WakeLockReleaseSource
  detail?: string
}

export interface WakeLockSentinelLike {
  release(): Promise<void>
  addEventListener(type: 'release', listener: () => void): void
  removeEventListener(type: 'release', listener: () => void): void
}

export interface WakeLockApiLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>
}

export interface VisibilityDocumentLike {
  visibilityState: 'visible' | 'hidden'
  addEventListener(type: 'visibilitychange', listener: () => void): void
  removeEventListener(type: 'visibilitychange', listener: () => void): void
}

function defaultWakeLock(): WakeLockApiLike | undefined {
  const global = globalThis as { navigator?: { wakeLock?: WakeLockApiLike } }
  return global.navigator?.wakeLock
}

function defaultVisibilityDocument(): VisibilityDocumentLike | undefined {
  const global = globalThis as { document?: VisibilityDocumentLike }
  return global.document
}

export interface WakeLockServiceDeps {
  wakeLock?: WakeLockApiLike | undefined
  visibilityDocument?: VisibilityDocumentLike | undefined
  now?: () => number
  onTransition?: (transition: WakeLockTransition) => void
}

export interface WakeLockService {
  readonly state: WakeLockState
  acquire(): Promise<void>
  release(): Promise<void>
  dispose(): Promise<void>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

export function createWakeLockService(deps: WakeLockServiceDeps = {}): WakeLockService {
  const wakeLock = 'wakeLock' in deps ? deps.wakeLock : defaultWakeLock()
  const visibilityDocument =
    'visibilityDocument' in deps ? deps.visibilityDocument : defaultVisibilityDocument()
  const now = deps.now ?? (() => performance.now())

  let state: WakeLockState = wakeLock ? 'released' : 'unsupported'
  let sentinel: WakeLockSentinelLike | null = null
  let pending: Promise<void> | null = null
  // User intent: true from acquire() until an explicit release()/dispose().
  // Platform-initiated releases leave it true, which is what makes
  // reacquire-on-visible fire only when the user meant to keep the lock.
  let wantHeld = false
  let disposed = false

  function transition(
    next: WakeLockState,
    extra: { releaseSource?: WakeLockReleaseSource; detail?: string } = {},
  ): void {
    state = next
    deps.onTransition?.({ at: now(), state: next, ...extra })
  }

  transition(state)

  const onSentinelRelease = () => {
    sentinel = null
    transition('released', { releaseSource: 'platform' })
  }

  async function requestLock(context?: string): Promise<void> {
    transition('acquiring', { detail: context })
    let acquired: WakeLockSentinelLike
    try {
      acquired = await wakeLock!.request('screen')
    } catch (error) {
      const rejection = `request rejected: ${errorMessage(error)}`
      transition('failed', { detail: context ? `${context}: ${rejection}` : rejection })
      return
    }
    if (!wantHeld) {
      await acquired.release()
      transition('released', {
        releaseSource: 'explicit',
        detail: 'released while acquisition was in flight',
      })
      return
    }
    sentinel = acquired
    acquired.addEventListener('release', onSentinelRelease)
    transition('active', { detail: context })
  }

  function startRequest(context?: string): Promise<void> {
    pending = requestLock(context).finally(() => {
      pending = null
    })
    return pending
  }

  function acquire(): Promise<void> {
    if (!wakeLock || disposed) return Promise.resolve()
    wantHeld = true
    if (sentinel) return Promise.resolve()
    return pending ?? startRequest()
  }

  async function release(): Promise<void> {
    wantHeld = false
    if (pending) await pending
    const held = sentinel
    if (!held) return
    sentinel = null
    // Removed before release() so the sentinel's own 'release' event does not
    // double-log this as a platform release.
    held.removeEventListener('release', onSentinelRelease)
    await held.release()
    transition('released', { releaseSource: 'explicit' })
  }

  const onVisibilityChange = () => {
    if (disposed || visibilityDocument?.visibilityState !== 'visible') return
    if (!wantHeld || sentinel || pending) return
    startRequest('reacquire after visibilitychange')
  }

  if (wakeLock) visibilityDocument?.addEventListener('visibilitychange', onVisibilityChange)

  async function dispose(): Promise<void> {
    if (disposed) return
    disposed = true
    if (wakeLock) visibilityDocument?.removeEventListener('visibilitychange', onVisibilityChange)
    await release()
  }

  return {
    get state() {
      return state
    },
    acquire,
    release,
    dispose,
  }
}
