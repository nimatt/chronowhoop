import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount } from 'svelte'
import Fly from '../screens/Fly.svelte'
import type { CameraMediaDevicesLike } from '../../core/camera/camera-service'
import { defaultMediaStreamTrackProcessor } from '../../core/detection/capture-support'
import type { FlySession } from './fly-session'

let container: HTMLElement
let instance: ReturnType<typeof mount> | undefined

const text = () => container.textContent ?? ''
const waitForText = (needle: string) => vi.waitFor(() => expect(text()).toContain(needle))

function buttonByText(label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label,
  )
  if (!button) throw new Error(`no button labelled ${JSON.stringify(label)}`)
  return button
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  if (instance) {
    void unmount(instance)
    instance = undefined
  }
  container.remove()
  vi.restoreAllMocks()
})

describe('Fly screen', () => {
  it('renders the setup step idle without touching the camera, arming gated', async () => {
    // Spy before mount: the fly session constructs its CameraService eagerly
    // but must only call getUserMedia on the Start gesture.
    const getUserMedia = vi.spyOn(navigator.mediaDevices, 'getUserMedia')

    instance = mount(Fly, { target: container })

    await waitForText('Quick session')
    expect(text()).toContain('start the camera')

    // Test mode and arming need a running capture (item: Arm gated until
    // camera running).
    expect(buttonByText('Start camera').disabled).toBe(false)
    expect(buttonByText('Test mode').disabled).toBe(true)
    expect(buttonByText('Arm').disabled).toBe(true)

    expect(getUserMedia).not.toHaveBeenCalled()
  })
})

// Real capture wiring, Chromium only: MediaStreamTrackProcessor (which
// CameraSource is built on) does not exist in WebKit — same gate as the lab
// tests. The scene is deliberately near-static (frames flow, but no strip
// ever crosses the trigger level) so the real detector produces NO crossings;
// laps are driven through the session's injectCrossing test seam instead —
// optically driving deterministic crossings through a captureStream is too
// flaky for CI.
describe.runIf(typeof defaultMediaStreamTrackProcessor() === 'function')(
  'Fly screen session flow (canvas captureStream behind the mediaDevices seam)',
  () => {
    let disposeScene: (() => void) | undefined

    function startQuietScene() {
      const canvas = document.createElement('canvas')
      canvas.width = 320
      canvas.height = 180
      document.body.appendChild(canvas)
      const ctx = canvas.getContext('2d')!
      let flip = false
      const draw = () => {
        ctx.fillStyle = '#202020'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        // A single toggling pixel keeps the captured canvas dirty (so frames
        // keep flowing) without ever making a strip hot.
        ctx.fillStyle = flip ? '#242424' : '#1c1c1c'
        flip = !flip
        ctx.fillRect(0, 0, 1, 1)
      }
      draw()
      const timer = setInterval(draw, 33)
      const stream = canvas.captureStream(30)
      disposeScene = () => {
        clearInterval(timer)
        for (const track of stream.getTracks()) track.stop()
        canvas.remove()
      }
      const mediaDevices: CameraMediaDevicesLike = { getUserMedia: async () => stream }
      return { mediaDevices }
    }

    afterEach(() => {
      disposeScene?.()
      disposeScene = undefined
      // Remove any fake visibilityState shadowing the prototype getter.
      Reflect.deleteProperty(document, 'visibilityState')
    })

    // fly-session reads document.visibilityState inside its visibilitychange
    // listener, so faking a hide/show is: shadow the prototype getter with an
    // own property, then dispatch the event on document.
    function setPageVisibility(state: 'hidden' | 'visible') {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => state,
      })
      document.dispatchEvent(new Event('visibilitychange'))
    }

    const INTERRUPTION_NOTICE = 'Detection was interrupted — laps during the gap were not detected.'

    function mountFly(mediaDevices: CameraMediaDevicesLike): FlySession {
      let session: FlySession | undefined
      instance = mount(Fly, {
        target: container,
        props: { mediaDevices, onsession: (created: FlySession) => (session = created) },
      })
      if (!session) throw new Error('Fly did not hand out its session')
      return session
    }

    it(
      'runs setup → armed → laps (injected) → discard → stopped lap table → new session',
      async () => {
        const { mediaDevices } = startQuietScene()
        const session = mountFly(mediaDevices)

        await waitForText('Quick session')
        buttonByText('Start camera').click()

        // Camera running gates arming; wake lock may be unsupported/failed in
        // headless — tolerated (only a warning line, never a blocker).
        await vi.waitFor(() => expect(buttonByText('Arm').disabled).toBe(false), {
          timeout: 15000,
        })
        expect(session.captureRunning).toBe(true)

        buttonByText('Arm').click()
        await waitForText('ARMED')
        expect(text()).toContain('first crossing starts the clock')
        expect(session.phase).toBe('armed')

        // Crossing timestamps live in the capture-time domain — any monotonic
        // ms values work. min lap time defaults to 3000 ms.
        session.injectCrossing({ timestampMs: 1000, direction: 'ltr' }) // starts the clock
        await vi.waitFor(() => expect(text()).not.toContain('first crossing starts the clock'))

        session.injectCrossing({ timestampMs: 15320, direction: 'ltr' }) // lap 1: 14.32
        await waitForText('14.32')
        session.injectCrossing({ timestampMs: 28650, direction: 'ltr' }) // lap 2: 13.33
        await waitForText('13.33')

        // Wrong-direction and debounced crossings change nothing.
        session.injectCrossing({ timestampMs: 29000, direction: 'rtl' })
        session.injectCrossing({ timestampMs: 29500, direction: 'ltr' })
        expect(session.laps.length).toBe(2)

        // Discard the most recent lap (13.33); timing continues unaffected.
        buttonByText('Discard last lap').click()
        await vi.waitFor(() => expect(session.laps[1]?.status).toBe('discarded'))
        expect(buttonByText('Discard last lap').disabled).toBe(true)

        session.injectCrossing({ timestampMs: 44650, direction: 'ltr' }) // lap 3: 16.00
        await waitForText('16.00')

        buttonByText('Stop').click()
        await waitForText('Session over')
        expect(session.phase).toBe('stopped')

        // Session-end lap table: all three laps, the discarded one struck
        // through (still listed), best lap highlighted, records computed.
        const rows = Array.from(container.querySelectorAll('tbody tr'))
        expect(rows.length).toBe(3)
        expect(rows[0].textContent).toContain('14.32')
        expect(rows[0].textContent).toContain('valid')
        expect(rows[0].textContent).toContain('best')
        expect(rows[0].classList.contains('best')).toBe(true)
        expect(rows[1].textContent).toContain('13.33')
        expect(rows[1].textContent).toContain('discarded')
        expect(rows[1].classList.contains('discarded')).toBe(true)
        expect(rows[2].textContent).toContain('16.00')
        // Two valid laps split by a discard: no best-three window.
        expect(text()).not.toContain('best three consecutive —')
        expect(text()).toContain('Nothing is saved')

        // New session returns to setup with the camera still running: arming
        // is immediately available again.
        buttonByText('New session').click()
        await waitForText('Suggest trigger')
        expect(session.phase).toBe('setup')
        expect(session.captureRunning).toBe(true)
        expect(buttonByText('Arm').disabled).toBe(false)
        expect(session.laps.length).toBe(0)
      },
      45000,
    )

    it(
      'test mode counts injected crossings and returns to setup; camera death while armed auto-stops with laps retained',
      async () => {
        const { mediaDevices } = startQuietScene()
        const session = mountFly(mediaDevices)

        await waitForText('Quick session')
        buttonByText('Start camera').click()
        await vi.waitFor(() => expect(buttonByText('Test mode').disabled).toBe(false), {
          timeout: 15000,
        })

        buttonByText('Test mode').click()
        await waitForText('crossings detected')
        session.injectCrossing({ timestampMs: 1000, direction: 'ltr' })
        session.injectCrossing({ timestampMs: 1400, direction: 'ltr' }) // no debounce in test mode
        session.injectCrossing({ timestampMs: 2000, direction: 'rtl' }) // wrong direction: silent
        await vi.waitFor(() => expect(session.testCrossingCount).toBe(2))

        buttonByText('Back to setup').click()
        await waitForText('Suggest trigger')
        expect(session.phase).toBe('setup')

        buttonByText('Arm').click()
        await waitForText('ARMED')
        session.injectCrossing({ timestampMs: 1000, direction: 'ltr' })
        session.injectCrossing({ timestampMs: 15320, direction: 'ltr' })
        await vi.waitFor(() => expect(session.laps.length).toBe(1))

        // External track death while armed (product.md interruption
        // decision): the session stops automatically, laps retained,
        // failure surfaced prominently.
        const state = session.camera.state
        if (state.status !== 'active') throw new Error('camera not active')
        state.stream.getVideoTracks()[0].dispatchEvent(new Event('ended'))

        await waitForText('stopped automatically')
        expect(session.phase).toBe('stopped')
        expect(session.stopCause).toBe('camera-lost')
        expect(session.laps.length).toBe(1)
        expect(text()).toContain('14.32')
      },
      45000,
    )

    it(
      'page hidden while armed shows a dismissable interruption notice on return; hidden in setup does not',
      async () => {
        const { mediaDevices } = startQuietScene()
        const session = mountFly(mediaDevices)

        await waitForText('Quick session')
        buttonByText('Start camera').click()
        await vi.waitFor(() => expect(buttonByText('Arm').disabled).toBe(false), {
          timeout: 15000,
        })

        // Hidden while still in setup: no notice on return.
        setPageVisibility('hidden')
        setPageVisibility('visible')
        expect(text()).not.toContain(INTERRUPTION_NOTICE)

        buttonByText('Arm').click()
        await waitForText('ARMED')
        session.injectCrossing({ timestampMs: 1000, direction: 'ltr' })
        await vi.waitFor(() => expect(session.clockStarted).toBe(true))

        // product.md interruption decision: hidden while armed → detection is
        // interrupted; the notice only shows once the page is visible again.
        setPageVisibility('hidden')
        expect(text()).not.toContain(INTERRUPTION_NOTICE)
        setPageVisibility('visible')
        await waitForText(INTERRUPTION_NOTICE)

        // The session stayed armed the whole time — never auto-stopped.
        expect(session.phase).toBe('armed')
        expect(text()).toContain('ARMED')

        buttonByText('Dismiss').click()
        await vi.waitFor(() => expect(text()).not.toContain(INTERRUPTION_NOTICE))
        expect(session.phase).toBe('armed')

        // Detection keeps recording: a crossing after the gap completes a lap.
        session.injectCrossing({ timestampMs: 15320, direction: 'ltr' })
        await waitForText('14.32')
        expect(session.laps.length).toBe(1)
      },
      45000,
    )

    it(
      'best-three-consecutive window is highlighted in the lap table with its total in legend and records',
      async () => {
        const { mediaDevices } = startQuietScene()
        const session = mountFly(mediaDevices)

        await waitForText('Quick session')
        buttonByText('Start camera').click()
        await vi.waitFor(() => expect(buttonByText('Arm').disabled).toBe(false), {
          timeout: 15000,
        })

        buttonByText('Arm').click()
        await waitForText('ARMED')

        // Four valid laps where the best window is laps 2–4, so the class
        // assertion discriminates (a 3-lap session would mark every row).
        session.injectCrossing({ timestampMs: 1000, direction: 'ltr' }) // starts the clock
        session.injectCrossing({ timestampMs: 21000, direction: 'ltr' }) // lap 1: 20.00
        session.injectCrossing({ timestampMs: 35320, direction: 'ltr' }) // lap 2: 14.32
        session.injectCrossing({ timestampMs: 48650, direction: 'ltr' }) // lap 3: 13.33
        session.injectCrossing({ timestampMs: 64650, direction: 'ltr' }) // lap 4: 16.00
        await vi.waitFor(() => expect(session.laps.length).toBe(4))

        buttonByText('Stop').click()
        await waitForText('Session over')

        const rows = Array.from(container.querySelectorAll('tbody tr'))
        expect(rows.length).toBe(4)
        expect(rows.map((row) => row.classList.contains('best-three'))).toEqual([
          false,
          true,
          true,
          true,
        ])

        // Window total 14.32 + 13.33 + 16.00 = 43.65, in both the table
        // legend and the session records header.
        expect(text()).toContain('best three consecutive — 43.65 s total')
        const records = container.querySelector('.records')
        expect(records?.textContent).toContain('best 3 consecutive')
        expect(records?.textContent).toContain('43.65')
      },
      45000,
    )

    it(
      'armed clock ticks via rAF and rebases when a lap completes',
      async () => {
        const { mediaDevices } = startQuietScene()
        const session = mountFly(mediaDevices)

        const clockSeconds = () => {
          const value = container.querySelector('.clock')?.textContent ?? ''
          const match = /^(?:(\d+):)?(\d+)\.(\d)$/.exec(value)
          if (!match) throw new Error(`clock not running: ${JSON.stringify(value)}`)
          const minutes = match[1] === undefined ? 0 : Number(match[1])
          return minutes * 60 + Number(match[2]) + Number(match[3]) / 10
        }

        await waitForText('Quick session')
        buttonByText('Start camera').click()
        await vi.waitFor(() => expect(buttonByText('Arm').disabled).toBe(false), {
          timeout: 15000,
        })

        buttonByText('Arm').click()
        await waitForText('ARMED')
        expect(container.querySelector('.clock')?.textContent).toBe('· · ·')

        session.injectCrossing({ timestampMs: 1000, direction: 'ltr' })
        await vi.waitFor(() =>
          expect(container.querySelector('.clock')?.textContent).toMatch(/\d+\.\d/),
        )

        // Liveness: the rAF loop keeps writing — a later sample differs from
        // an earlier one (tenths advance every 100 ms of real time).
        const firstSample = clockSeconds()
        await vi.waitFor(() => expect(clockSeconds()).toBeGreaterThan(firstSample), {
          timeout: 5000,
        })

        // Rebase: let the clock accumulate visible headroom, then complete a
        // lap — the display restarts near zero, below the pre-lap reading.
        await vi.waitFor(() => expect(clockSeconds()).toBeGreaterThanOrEqual(0.3), {
          timeout: 5000,
        })
        const preLapSample = clockSeconds()
        session.injectCrossing({ timestampMs: 15320, direction: 'ltr' })
        await waitForText('14.32')
        await vi.waitFor(() => expect(clockSeconds()).toBeLessThan(preLapSample), {
          timeout: 5000,
        })
      },
      45000,
    )
  },
)
