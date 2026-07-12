import { describe, expect, it } from 'vitest'
import { teeSource } from './tee'
import { ClipSource } from './clip-source'
import type { LumaFrame } from './types'

function frame(captureTimeMs: number): LumaFrame {
  return { data: new Uint8Array(4).fill(captureTimeMs), width: 2, height: 2, captureTimeMs }
}

describe('teeSource', () => {
  it('forwards every frame to both the tap and the downstream consumer, tap first', () => {
    const source = new ClipSource([frame(1), frame(2), frame(3)])
    const order: string[] = []
    const tee = teeSource(source, (f) => order.push(`tap:${f.captureTimeMs}`))
    tee.start((f) => order.push(`down:${f.captureTimeMs}`))
    source.pumpAll()
    expect(order).toEqual(['tap:1', 'down:1', 'tap:2', 'down:2', 'tap:3', 'down:3'])
  })

  it('delivers the same frame reference to tap and consumer (no copy)', () => {
    const source = new ClipSource([frame(1)])
    let tapped: LumaFrame | undefined
    let received: LumaFrame | undefined
    const tee = teeSource(source, (f) => (tapped = f))
    tee.start((f) => (received = f))
    source.pumpAll()
    expect(tapped).toBeDefined()
    expect(tapped).toBe(received)
  })

  it('stop() delegates to the inner source', () => {
    let stopped = false
    const tee = teeSource(
      {
        start: () => {},
        stop: () => {
          stopped = true
        },
      },
      () => {},
    )
    tee.start(() => {})
    tee.stop()
    expect(stopped).toBe(true)
  })
})
