// Live-session write path (plan 06 item 5): the glue between SessionEngine
// and Storage that persists a session as it is flown. The never-block
// contract is the whole point — a slow, hung, or failing write must never
// delay lap timing or speech (proven end-to-end by full-loop-storage.test.ts):
//
// - sessionStarted/sessionUpdated are synchronous fire-and-forget: they
//   snapshot (structuredClone) the session at call time — later engine
//   mutations cannot tear an in-flight write — and never throw or await.
// - Single-flight with latest-wins coalescing: at most one saveSession call
//   is in flight; while one is, only the NEWEST snapshot is held, replacing
//   any queued or retry-pending one (every snapshot is the full session, so
//   the newest supersedes everything before it).
// - Failed writes retry with backoff (default 500/2000/5000 ms) ONLY for
//   kind 'write-failed'; quota-exceeded (and every other kind) surfaces
//   immediately without retry. A new snapshot cancels any scheduled retry
//   and saves immediately with a fresh attempt budget.
// - Errors surface exclusively through `state` / onStateChange; the UI reads
//   them after Stop ("unsaved laps"), never mid-flight.
// - flush() awaits quiescence for the Stop path: any scheduled retry runs
//   immediately (no wall-clock backoff while the user waits), and further
//   write-failed retries during a flush also run immediately until the
//   attempt budget is spent. flush never rejects — inspect `state` after.
//
// Call shape (the fly screen wires this): sessionStarted at arm (the file
// exists before the first crossing — a zero-lap crash leaves a recoverable
// record, storage.md), sessionUpdated on every lap and every discard, flush
// after Stop. One persister handles one session at a time: coalescing is
// global, not per session id, so sessionStarted while state.pending would
// drop the previous session's unsaved tail — the fly flow gates arming on
// `state.pending` instead of relying on flush (which never resolves against
// a hung storage).
//
// Ownership rule: a session is repo-editable only once its persister is
// quiescent (state.pending false) — until then the persister may still
// overwrite the file with a newer snapshot of its own, clobbering edits made
// through the repository layer.

import type { Session } from '../domain/types'
import { isStorageError, type Storage, type StorageErrorKind } from '../storage/storage'

export interface PersisterError {
  kind: StorageErrorKind
  message: string
}

// The only Storage member the live-session write path needs. Named, and
// narrowed, so the fly flow can be handed a handle that CANNOT reach the
// courses.json members (saveCourses / deleteCourse / importAll / exportAll /
// resumePendingDeletions) — those belong to CoursesRepo's critical section and
// nothing else (repos.ts). saveSession is not part of it: it writes one session
// file, atomically, and never touches courses.json.
export type SessionWriter = Pick<Storage, 'saveSession'>

export interface PersisterState {
  // Unsaved data exists: a save is in flight, queued, or awaiting retry.
  pending: boolean
  // From the most recent settled attempt; cleared by the next success and by
  // sessionStarted.
  lastError?: PersisterError
  // Lap count of the last successfully saved snapshot — an honest "saved
  // through lap N" (it deliberately says nothing about discard flags, which
  // ride along in the same snapshot). Undefined until the first success.
  savedLapCount?: number
}

export interface SessionPersisterOptions {
  scheduleFn?: (fn: () => void, delayMs: number) => unknown
  cancelFn?: (handle: unknown) => void
  // Fired after every observable state transition with a fresh snapshot.
  onStateChange?: (state: PersisterState) => void
}

export interface SessionPersister {
  sessionStarted(session: Session): void
  sessionUpdated(session: Session): void
  flush(): Promise<void>
  readonly state: PersisterState
}

// Backoff delays for consecutive 'write-failed' attempts on one snapshot;
// length = maximum number of retries. Exported so tests pin the schedule.
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [500, 2000, 5000]

function toPersisterError(error: unknown): PersisterError {
  if (isStorageError(error)) return { kind: error.kind, message: error.message }
  // A non-StorageError from an implementation is treated as a (retriable)
  // failed write rather than crashing the caller-facing contract.
  return { kind: 'write-failed', message: error instanceof Error ? error.message : String(error) }
}

export function createSessionPersister(
  storage: SessionWriter,
  options: SessionPersisterOptions = {},
): SessionPersister {
  const scheduleFn = options.scheduleFn ?? ((fn, ms) => setTimeout(fn, ms))
  const cancelFn =
    options.cancelFn ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const onStateChange = options.onStateChange

  let inFlight = false
  let queued: Session | null = null
  let retrySnapshot: Session | null = null
  let retryHandle: unknown = null
  let failedAttempts = 0
  let lastError: PersisterError | undefined
  let savedLapCount: number | undefined
  let flushWaiters: (() => void)[] = []

  function currentState(): PersisterState {
    const state: PersisterState = {
      pending: inFlight || queued !== null || retrySnapshot !== null,
    }
    if (lastError !== undefined) state.lastError = { ...lastError }
    if (savedLapCount !== undefined) state.savedLapCount = savedLapCount
    return state
  }

  function notify(): void {
    onStateChange?.(currentState())
    if (!inFlight && queued === null && retrySnapshot === null && flushWaiters.length > 0) {
      const waiters = flushWaiters
      flushWaiters = []
      for (const resolve of waiters) resolve()
    }
  }

  function cancelScheduledRetry(): void {
    if (retryHandle !== null) cancelFn(retryHandle)
    retryHandle = null
    retrySnapshot = null
  }

  function startSave(snapshot: Session): void {
    inFlight = true
    notify()
    void (async () => {
      try {
        // Awaiting inside the async IIFE also catches a saveSession that
        // throws synchronously — nothing propagates to the caller.
        await storage.saveSession(snapshot)
        onSaved(snapshot)
      } catch (error) {
        onFailed(snapshot, error)
      }
    })()
  }

  function startNext(snapshot: Session): void {
    failedAttempts = 0
    startSave(snapshot)
  }

  function onSaved(snapshot: Session): void {
    inFlight = false
    lastError = undefined
    savedLapCount = snapshot.laps.length
    if (queued !== null) {
      const next = queued
      queued = null
      startNext(next)
      return
    }
    failedAttempts = 0
    notify()
  }

  function onFailed(snapshot: Session, error: unknown): void {
    inFlight = false
    lastError = toPersisterError(error)
    if (queued !== null) {
      // A newer snapshot supersedes the failed one — save it instead of
      // retrying stale data.
      const next = queued
      queued = null
      startNext(next)
      return
    }
    failedAttempts++
    const delayMs = DEFAULT_RETRY_DELAYS_MS[failedAttempts - 1]
    if (lastError.kind !== 'write-failed' || delayMs === undefined) {
      failedAttempts = 0
      notify()
      return
    }
    if (flushWaiters.length > 0) {
      startSave(snapshot)
      return
    }
    retrySnapshot = snapshot
    retryHandle = scheduleFn(() => {
      const next = retrySnapshot
      retryHandle = null
      retrySnapshot = null
      if (next !== null) startSave(next)
    }, delayMs)
    notify()
  }

  function accept(session: Session): void {
    const snapshot = structuredClone(session)
    cancelScheduledRetry()
    if (inFlight) {
      queued = snapshot
      notify()
      return
    }
    startNext(snapshot)
  }

  return {
    sessionStarted(session: Session): void {
      lastError = undefined
      savedLapCount = undefined
      accept(session)
    },
    sessionUpdated(session: Session): void {
      accept(session)
    },
    flush(): Promise<void> {
      if (!inFlight && queued === null && retrySnapshot === null) return Promise.resolve()
      const settled = new Promise<void>((resolve) => flushWaiters.push(resolve))
      if (retrySnapshot !== null) {
        const next = retrySnapshot
        cancelScheduledRetry()
        startSave(next)
      }
      return settled
    },
    get state(): PersisterState {
      return currentState()
    },
  }
}
