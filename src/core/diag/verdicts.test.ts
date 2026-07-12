import { describe, expect, it } from 'vitest'
import { frameIntervalForFps, fpsVerdict, jitterVerdict, latencyVerdict } from './verdicts'

describe('fpsVerdict', () => {
  it('is n/a when fps is unmeasured', () => {
    expect(fpsVerdict(undefined)).toBe('na')
  })

  it('passes at exactly the 2%-tolerant 60 fps boundary (58.8)', () => {
    expect(fpsVerdict(58.8)).toBe('pass')
    expect(fpsVerdict(60)).toBe('pass')
    expect(fpsVerdict(59.94)).toBe('pass')
  })

  it('degrades just below the pass boundary', () => {
    expect(fpsVerdict(58.79)).toBe('warn')
  })

  it('degrades at exactly the 2%-tolerant 30 fps boundary (29.4)', () => {
    expect(fpsVerdict(29.4)).toBe('warn')
    expect(fpsVerdict(30)).toBe('warn')
  })

  it('fails just below the degraded boundary', () => {
    expect(fpsVerdict(29.39)).toBe('fail')
    expect(fpsVerdict(15)).toBe('fail')
  })
})

describe('jitterVerdict', () => {
  it('is n/a when either stat is missing', () => {
    expect(jitterVerdict({ jitterStddevMs: undefined, medianDeltaMs: 16 })).toBe('na')
    expect(jitterVerdict({ jitterStddevMs: 1, medianDeltaMs: undefined })).toBe('na')
  })

  it('passes at exactly half the median delta (inclusive boundary)', () => {
    expect(jitterVerdict({ jitterStddevMs: 8, medianDeltaMs: 16 })).toBe('pass')
  })

  it('passes below and fails above half the median delta', () => {
    expect(jitterVerdict({ jitterStddevMs: 2, medianDeltaMs: 16 })).toBe('pass')
    expect(jitterVerdict({ jitterStddevMs: 8.01, medianDeltaMs: 16 })).toBe('fail')
  })

  it('passes zero jitter even when the median delta is zero', () => {
    expect(jitterVerdict({ jitterStddevMs: 0, medianDeltaMs: 0 })).toBe('pass')
  })
})

describe('frameIntervalForFps', () => {
  it('assumes 60 fps before the frame loop has measured', () => {
    expect(frameIntervalForFps(null)).toBeCloseTo(1000 / 60, 10)
  })

  it('derives the interval from the measured fps', () => {
    expect(frameIntervalForFps(50)).toBe(20)
    expect(frameIntervalForFps(30)).toBeCloseTo(1000 / 30, 10)
  })
})

describe('latencyVerdict', () => {
  const interval = 1000 / 60

  it('is n/a without stats', () => {
    expect(latencyVerdict(undefined, interval)).toBe('na')
  })

  it('passes when median and p95 are both at the interval (inclusive boundary)', () => {
    expect(latencyVerdict({ medianMs: interval, p95Ms: interval }, interval)).toBe('pass')
    expect(latencyVerdict({ medianMs: 10, p95Ms: 15 }, interval)).toBe('pass')
  })

  it('fails when the median exceeds the interval', () => {
    expect(latencyVerdict({ medianMs: 18, p95Ms: 18 }, interval)).toBe('fail')
  })

  it('fails on a p95-only violation even with a comfortable median', () => {
    expect(latencyVerdict({ medianMs: 12, p95Ms: 25 }, interval)).toBe('fail')
  })
})
