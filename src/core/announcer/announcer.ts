// Speech announcer (plan 05 item 3): pure policy + formatting behind a
// minimal Speaker seam. AudioService satisfies Speaker structurally — no
// adapter needed (`speak(text)` returning a handle whose `settled` resolves
// when the utterance ends or errors; it never rejects).
//
// Decided semantics (tests pin each; see 05-flyable-timer.notes.md):
// - Formatting: duration is ROUNDED to the nearest tenth of a second, half
//   up — 14.32 s → "14 3", 14.35 → "14 4", 14.96 → "15 0". Digit text
//   ("14 3") so TTS reads the spec's terse "fourteen three" without
//   hand-rolled number-to-words. "best" prefix when session-best lap,
//   "best three" suffix when session-best three; both can apply:
//   "best 14 1 best three".
// - Record flags announce only IMPROVEMENTS over a previously existing
//   record of the same kind. The first valid lap is trivially the best lap
//   and is NOT announced as "best" (it would be noise on lap 1 of every
//   session); symmetrically, the first-ever best-three window is not
//   announced — only a window strictly beating a previous one is. Ties never
//   announce (consistent with records' first-occurrence-wins tie-break).
// - Queue policy: skip-stale-enqueue-next (ADR 0009 amendment default, no
//   S22 speech evidence yet). Nothing in flight → speak immediately. In
//   flight → hold ONLY the newest announcement as pending; a newer one
//   replaces it, and the replaced text is logged 'dropped-stale'. When the
//   in-flight utterance settles, the pending one (if any) is spoken.
//   cancel() is never called.
// - Settle watchdog: a wedged WebSpeech engine (documented AudioService
//   failure mode) can lose the terminal event, so `settled` may never
//   resolve. Each utterance races `settled` against an injectable timer
//   (default 8 s — longer than any lap announcement); on timeout the
//   utterance is treated as settled (logged 'settle-timeout') and the queue
//   advances. A LATE real settle after a timeout is a no-op (guarded by
//   utterance identity). A speaker that THROWS from speak() is treated the
//   same way, logged 'speak-failed' — either way one bad utterance never
//   wedges future announcements.
// - reset() drops the pending queued announcement (stop/arm boundaries must
//   not leak a stale announcement into the next session). The in-flight
//   utterance, if any, is left to finish — cancel() is never called — and
//   its settle then speaks nothing.

import type { Lap } from '../domain/types'
import { bestLap, bestThreeConsecutive } from '../records/records'

export interface SpeakerHandle {
  readonly settled: Promise<void>
}

export interface Speaker {
  speak(text: string): SpeakerHandle
}

export interface AnnouncementRecords {
  isSessionBestLap: boolean
  isSessionBestThree: boolean
}

export function formatLapAnnouncement(lap: Lap, records: AnnouncementRecords): string {
  const tenths = Math.round(lap.durationMs / 100)
  const parts: string[] = []
  if (records.isSessionBestLap) parts.push('best')
  parts.push(`${Math.floor(tenths / 10)} ${tenths % 10}`)
  if (records.isSessionBestThree) parts.push('best three')
  return parts.join(' ')
}

// `laps` is the session's full ordered lap list with `newLap` already
// appended as its last element (exactly what SessionEngine's onLap callback
// provides).
export function computeAnnouncementRecords(
  laps: readonly Lap[],
  newLap: Lap,
): AnnouncementRecords {
  if (laps[laps.length - 1] !== newLap) {
    throw new Error('computeAnnouncementRecords: newLap must be the last element of laps')
  }
  const previousLaps = laps.slice(0, -1)

  const previousBestLap = bestLap(previousLaps)
  const isSessionBestLap =
    newLap.status === 'valid' &&
    previousBestLap !== undefined &&
    newLap.durationMs < previousBestLap.durationMs

  // Any window containing newLap ends at it (windows are contiguous and
  // newLap is last), so a lower overall best-three total than before means
  // the new lap just completed an improving window.
  const previousBestThree = bestThreeConsecutive(previousLaps)
  const currentBestThree = bestThreeConsecutive(laps)
  const isSessionBestThree =
    previousBestThree !== undefined &&
    currentBestThree !== undefined &&
    currentBestThree.totalMs < previousBestThree.totalMs

  return { isSessionBestLap, isSessionBestThree }
}

export type AnnounceAction =
  | 'spoken-immediately'
  | 'queued'
  | 'dropped-stale'
  | 'settle-timeout'
  | 'speak-failed'

export interface AnnounceDecision {
  text: string
  action: AnnounceAction
}

export interface AnnouncerOptions {
  settleTimeoutMs?: number
  setTimeoutFn?: (fn: () => void, ms: number) => unknown
  clearTimeoutFn?: (handle: unknown) => void
}

const DEFAULT_SETTLE_TIMEOUT_MS = 8000

export class Announcer {
  readonly #speaker: Speaker
  readonly #decisions: AnnounceDecision[] = []
  readonly #settleTimeoutMs: number
  readonly #setTimeoutFn: (fn: () => void, ms: number) => unknown
  readonly #clearTimeoutFn: (handle: unknown) => void
  #utteranceSeq = 0
  #activeUtterance: number | null = null
  #pendingText: string | null = null

  constructor(speaker: Speaker, options: AnnouncerOptions = {}) {
    this.#speaker = speaker
    this.#settleTimeoutMs = options.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS
    this.#setTimeoutFn = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms))
    this.#clearTimeoutFn =
      options.clearTimeoutFn ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  }

  get decisions(): readonly AnnounceDecision[] {
    return this.#decisions
  }

  announceLap(lap: Lap, records: AnnouncementRecords): void {
    this.announce(formatLapAnnouncement(lap, records))
  }

  announce(text: string): void {
    if (this.#activeUtterance === null) {
      this.#decide({ text, action: 'spoken-immediately' })
      this.#speakNow(text)
      return
    }
    if (this.#pendingText !== null) {
      this.#decide({ text: this.#pendingText, action: 'dropped-stale' })
    }
    this.#pendingText = text
    this.#decide({ text, action: 'queued' })
  }

  reset(): void {
    this.#pendingText = null
  }

  #speakNow(text: string): void {
    const utteranceId = ++this.#utteranceSeq
    this.#activeUtterance = utteranceId

    const watchdog = this.#setTimeoutFn(() => {
      if (this.#activeUtterance !== utteranceId) return
      this.#decide({ text, action: 'settle-timeout' })
      this.#finishUtterance()
    }, this.#settleTimeoutMs)

    // Whichever of real settle / watchdog comes second is a no-op: finishing
    // an utterance clears #activeUtterance (and speaking the pending one
    // installs a fresh id), so the stale arm fails the identity check.
    const onSettled = () => {
      if (this.#activeUtterance !== utteranceId) return
      this.#clearTimeoutFn(watchdog)
      this.#finishUtterance()
    }

    let handle: SpeakerHandle
    try {
      handle = this.#speaker.speak(text)
    } catch {
      this.#clearTimeoutFn(watchdog)
      this.#decide({ text, action: 'speak-failed' })
      this.#finishUtterance()
      return
    }
    // Speaker.settled never rejects per contract; the rejection arm guards
    // against a foreign implementation wedging the queue forever.
    handle.settled.then(onSettled, onSettled)
  }

  #finishUtterance(): void {
    this.#activeUtterance = null
    if (this.#pendingText === null) return
    const text = this.#pendingText
    this.#pendingText = null
    this.#speakNow(text)
  }

  #decide(decision: AnnounceDecision): void {
    this.#decisions.push(decision)
  }
}
