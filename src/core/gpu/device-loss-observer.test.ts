import { describe, expect, it } from 'vitest'
import { observeDeviceLoss, type DeviceLossEvent } from './device-loss-observer'

function fakeClock(now: number) {
  return { now: () => now }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('observeDeviceLoss', () => {
  it('does not fire before the device is lost', async () => {
    const events: DeviceLossEvent[] = []
    observeDeviceLoss({ lost: new Promise(() => {}) }, (event) => events.push(event), fakeClock(0))
    await flushMicrotasks()
    expect(events).toEqual([])
  })

  it('reports reason, message, and injectable-clock time when the device is lost', async () => {
    let resolveLost!: (info: { reason: string; message: string }) => void
    const lost = new Promise<{ reason: string; message: string }>((resolve) => {
      resolveLost = resolve
    })
    const events: DeviceLossEvent[] = []
    observeDeviceLoss({ lost }, (event) => events.push(event), fakeClock(1234))

    resolveLost({ reason: 'destroyed', message: 'device was destroyed' })
    await flushMicrotasks()

    expect(events).toEqual([{ at: 1234, reason: 'destroyed', message: 'device was destroyed' }])
  })
})
