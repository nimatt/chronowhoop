/// <reference types="node" />

// Node-side proof of the /lab self-test logic against the real committed
// fixtures (the browser smoke test proves the same via the bundled assets).

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runSelfTest } from './self-test'

function readFixture(relative: string): Buffer {
  return readFileSync(fileURLToPath(new URL(`../../../${relative}`, import.meta.url)))
}

const clipBytes = new Uint8Array(readFixture('fixtures/clips/synthetic-crossing-64x36.cwclip'))
const energyJson = readFixture('fixtures/energies/synthetic-crossing-64x36.energy.json').toString('utf8')

describe('runSelfTest', () => {
  it('passes against the committed fixtures with default tunables', () => {
    const report = runSelfTest(clipBytes, energyJson)
    expect(report).toEqual({ pass: true, frameCount: 30 })
  })

  it('reports the first divergent frame when an energy differs', () => {
    const doctored = JSON.parse(energyJson) as {
      frames: Array<{ energies: number[] }>
    }
    doctored.frames[14].energies[3] += 1
    const report = runSelfTest(clipBytes, JSON.stringify(doctored))
    expect(report.pass).toBe(false)
    expect(report.divergence?.frameIndex).toBe(14)
    expect(report.divergence?.field).toBe('energies')
  })

  it('reports a frame-count mismatch as a detail, not a crash', () => {
    const doctored = JSON.parse(energyJson) as { frames: unknown[] }
    doctored.frames = doctored.frames.slice(0, 10)
    const report = runSelfTest(clipBytes, JSON.stringify(doctored))
    expect(report.pass).toBe(false)
    expect(report.detail).toContain('frames')
  })

  it('throws the format error on malformed clip bytes (caller reports it)', () => {
    expect(() => runSelfTest(clipBytes.slice(0, 10), energyJson)).toThrowError(/truncated/)
  })
})
