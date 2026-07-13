import { describe, expect, it } from 'vitest'
import { makeLap, makeSession } from './storage-contract'
import {
  compareSessionRecency,
  isCorruptError,
  isNotFoundError,
  isQuotaExceededError,
  isStorageError,
  isUnsupportedVersionError,
  isWriteFailedError,
  StorageError,
  summarizeSession,
} from './storage'

describe('StorageError taxonomy', () => {
  it('carries kind, message, name, and cause', () => {
    const cause = new Error('disk on fire')
    const error = new StorageError('write-failed', 'saving session failed', { cause })
    expect(error.kind).toBe('write-failed')
    expect(error.message).toBe('saving session failed')
    expect(error.name).toBe('StorageError')
    expect(error.cause).toBe(cause)
    expect(error).toBeInstanceOf(Error)
  })

  it('type guards discriminate by kind and reject foreign errors', () => {
    const notFound = new StorageError('not-found', 'x')
    const corrupt = new StorageError('corrupt', 'x')
    const quota = new StorageError('quota-exceeded', 'x')
    const writeFailed = new StorageError('write-failed', 'x')
    const unsupportedVersion = new StorageError('unsupported-version', 'x')
    const foreign = new Error('x')

    for (const error of [notFound, corrupt, quota, writeFailed, unsupportedVersion]) {
      expect(isStorageError(error)).toBe(true)
    }
    expect(isStorageError(foreign)).toBe(false)
    expect(isStorageError(undefined)).toBe(false)

    expect(isNotFoundError(notFound)).toBe(true)
    expect(isNotFoundError(corrupt)).toBe(false)
    expect(isCorruptError(corrupt)).toBe(true)
    expect(isCorruptError(quota)).toBe(false)
    expect(isQuotaExceededError(quota)).toBe(true)
    expect(isQuotaExceededError(foreign)).toBe(false)
    expect(isWriteFailedError(writeFailed)).toBe(true)
    expect(isWriteFailedError(notFound)).toBe(false)
    expect(isUnsupportedVersionError(unsupportedVersion)).toBe(true)
    expect(isUnsupportedVersionError(corrupt)).toBe(false)
  })
})

describe('compareSessionRecency', () => {
  it('orders by startedAt, then by id with the larger id newer', () => {
    const older = { id: 'z', startedAt: '2026-07-11T10:00:00.000Z' }
    const newer = { id: 'a', startedAt: '2026-07-12T10:00:00.000Z' }
    expect(compareSessionRecency(older, newer)).toBeLessThan(0)
    expect(compareSessionRecency(newer, older)).toBeGreaterThan(0)

    const tieSmall = { id: 'a', startedAt: '2026-07-12T10:00:00.000Z' }
    const tieLarge = { id: 'b', startedAt: '2026-07-12T10:00:00.000Z' }
    expect(compareSessionRecency(tieSmall, tieLarge)).toBeLessThan(0)
    expect(compareSessionRecency(tieLarge, tieSmall)).toBeGreaterThan(0)
    expect(compareSessionRecency(tieSmall, tieSmall)).toBe(0)
  })

  it('treats equivalent instants in different ISO spellings as ties', () => {
    const zulu = { id: 'a', startedAt: '2026-07-12T10:00:00Z' }
    const withMs = { id: 'b', startedAt: '2026-07-12T10:00:00.000Z' }
    expect(compareSessionRecency(zulu, withMs)).toBeLessThan(0)
  })
})

describe('summarizeSession', () => {
  it('counts laps and valid laps', () => {
    const session = makeSession({
      laps: [
        makeLap({ n: 1, status: 'valid' }),
        makeLap({ n: 2, status: 'discarded' }),
        makeLap({ n: 3, status: 'valid' }),
      ],
    })
    expect(summarizeSession(session)).toEqual({
      id: session.id,
      courseId: session.courseId,
      startedAt: session.startedAt,
      lapCount: 3,
      validLapCount: 2,
    })
  })

  it('summarizes a zero-lap session (created at arm, no crossings yet)', () => {
    const session = makeSession({ laps: [] })
    expect(summarizeSession(session)).toMatchObject({ lapCount: 0, validLapCount: 0 })
  })
})
