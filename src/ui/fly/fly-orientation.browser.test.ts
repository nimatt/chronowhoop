import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount } from 'svelte'
import type { CameraMediaDevicesLike } from '../../core/camera/camera-service'
import { defaultMediaStreamTrackProcessor } from '../../core/detection/capture-support'
import { DetectionPipeline } from '../../core/detection/pipeline'
import { MemoryStorage } from '../../core/storage/memory-storage'
import { makeCourse } from '../../core/storage/storage-contract'
import { createStorageContext } from '../data/storage-context.svelte'
import type { StorageContext } from '../data/storage-context'
import FlyFlow from './FlyFlow.svelte'
import type { FlySession } from './fly-session'
import type { OrientationQueryLike } from './orientation-binding'

// Orientation binding (detection.md "Orientation"): the ROI is bound to the
// orientation the camera was started in; rotating away warns and invalidates
// detection (crossings are lost) until the orientation is restored. Driven
// through the injectable matchMedia seam — FlyFlow is mounted directly so the
// seam reaches createFlySession without touching the route loader.

const COURSE = makeCourse({
  id: 'course-orientation',
  name: 'Rotation gate',
  direction: 'ltr',
  minLapTimeMs: 3000,
})

// Fake '(orientation: portrait)' MediaQueryList: flip() rotates the device.
class FakeOrientationQuery implements OrientationQueryLike {
  matches = true
  #listeners = new Set<() => void>()

  addEventListener(_type: 'change', listener: () => void): void {
    this.#listeners.add(listener)
  }

  removeEventListener(_type: 'change', listener: () => void): void {
    this.#listeners.delete(listener)
  }

  rotateTo(orientation: 'portrait' | 'landscape'): void {
    this.matches = orientation === 'portrait'
    for (const listener of this.#listeners) listener()
  }
}

const WARNING = 'Rotate the phone back to portrait'
const INTERRUPTION_NOTICE = 'Detection was interrupted — laps during the gap were not detected.'

let container: HTMLElement
let instance: ReturnType<typeof mount> | undefined
const contexts: StorageContext[] = []

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
  for (const context of contexts.splice(0)) context.destroy()
  container.remove()
  vi.restoreAllMocks()
})

// Same Chromium gate as fly.browser.test.ts: the capture chain needs
// MediaStreamTrackProcessor, and the same quiet canvas-captureStream scene
// keeps frames flowing without optical crossings — laps are injected.
describe.runIf(typeof defaultMediaStreamTrackProcessor() === 'function')(
  'Fly flow orientation binding (fake matchMedia seam)',
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
        ctx.fillStyle = flip ? '#242424' : '#1c1c1c'
        flip = !flip
        ctx.fillRect(0, 0, 1, 1)
      }
      draw()
      const timer = setInterval(draw, 33)
      // A fresh stream per call: stopping the camera stops the granted
      // stream's tracks, so a camera restart must not be handed a dead one.
      const streams: MediaStream[] = []
      disposeScene = () => {
        clearInterval(timer)
        for (const stream of streams) for (const track of stream.getTracks()) track.stop()
        canvas.remove()
      }
      const mediaDevices: CameraMediaDevicesLike = {
        getUserMedia: async () => {
          const stream = canvas.captureStream(30)
          streams.push(stream)
          return stream
        },
      }
      return { mediaDevices }
    }

    afterEach(() => {
      disposeScene?.()
      disposeScene = undefined
    })

    async function mountFlow(orientation: FakeOrientationQuery): Promise<FlySession> {
      const { mediaDevices } = startQuietScene()
      const context = createStorageContext({ createStorage: () => new MemoryStorage() })
      contexts.push(context)
      if (!(await context.coursesRepo.saveCourse({ ...COURSE }))) {
        throw new Error('failed to seed the course')
      }
      let session: FlySession | undefined
      instance = mount(FlyFlow, {
        target: container,
        props: {
          context,
          course: COURSE,
          mediaDevices,
          matchMedia: () => orientation,
          onsession: (created: FlySession) => (session = created),
        },
      })
      await vi.waitFor(() => expect(session).toBeDefined())
      return session!
    }

    async function startCameraAndWaitForArm(): Promise<void> {
      await waitForText('Rotation gate')
      buttonByText('Start camera').click()
      await vi.waitFor(() => expect(buttonByText('Arm').disabled).toBe(false), {
        timeout: 15000,
      })
    }

    it(
      'armed: mismatch warns and drops crossings; restore re-records and raises the interruption notice',
      async () => {
        const orientation = new FakeOrientationQuery()
        const session = await mountFlow(orientation)

        await startCameraAndWaitForArm()
        expect(session.boundOrientation).toBe('portrait')

        buttonByText('Arm').click()
        await waitForText('ARMED')
        expect(session.detectionAttached).toBe(true)
        session.injectCrossing({ timestampMs: 1000, direction: 'ltr' }) // starts the clock
        await vi.waitFor(() => expect(session.clockStarted).toBe(true))

        // Rotate away: prominent warning, detection invalidated — the REAL
        // detector is detached (not just the injectCrossing guard), and an
        // injected crossing (the seam mirrors the detached detector) records
        // nothing.
        orientation.rotateTo('landscape')
        await waitForText(WARNING)
        expect(session.orientationMismatch).toBe(true)
        expect(session.detectionAttached).toBe(false)
        session.injectCrossing({ timestampMs: 15320, direction: 'ltr' })
        expect(session.laps.length).toBe(0)

        // Session stayed armed the whole time (timing continues; the
        // crossings during the mismatch are simply lost, per spec).
        expect(session.phase).toBe('armed')

        // Pin the restore EXECUTION order on the real machinery: the
        // pipeline's EMA background (which absorbed rotated frames) is reset
        // BEFORE a fresh detector is re-attached.
        const attachedWhenReset: boolean[] = []
        const realResetBackground = DetectionPipeline.prototype.resetBackground
        const resetSpy = vi
          .spyOn(DetectionPipeline.prototype, 'resetBackground')
          .mockImplementation(function (this: DetectionPipeline) {
            attachedWhenReset.push(session.detectionAttached)
            realResetBackground.call(this)
          })

        // Rotate back: warning clears, the interruption notice explains the
        // gap, and detection records again.
        orientation.rotateTo('portrait')
        await vi.waitFor(() => expect(text()).not.toContain(WARNING))
        await waitForText(INTERRUPTION_NOTICE)
        expect(resetSpy).toHaveBeenCalledTimes(1)
        expect(attachedWhenReset).toEqual([false])
        expect(session.detectionAttached).toBe(true)
        session.injectCrossing({ timestampMs: 30000, direction: 'ltr' }) // lap: 29.00
        await waitForText('29.00')
        expect(session.laps.length).toBe(1)
      },
      45000,
    )

    it(
      'stopping while still rotated carries the detection-gap notice to the stopped panel',
      async () => {
        const orientation = new FakeOrientationQuery()
        const session = await mountFlow(orientation)

        await startCameraAndWaitForArm()
        buttonByText('Arm').click()
        await waitForText('ARMED')

        orientation.rotateTo('landscape')
        await waitForText(WARNING)
        expect(session.detectionAttached).toBe(false)

        // Stop without ever restoring the orientation: the restore path (the
        // usual notice raiser) never runs, but the gap must survive to the
        // stopped panel.
        buttonByText('Stop').click()
        await waitForText('Session over')
        expect(text()).toContain(INTERRUPTION_NOTICE)
        expect(text()).not.toContain(WARNING)
      },
      45000,
    )

    it(
      'setup: mismatch disables Arm and Test mode until the orientation is restored',
      async () => {
        const orientation = new FakeOrientationQuery()
        const session = await mountFlow(orientation)

        await startCameraAndWaitForArm()
        expect(buttonByText('Test mode').disabled).toBe(false)

        orientation.rotateTo('landscape')
        await waitForText(WARNING)
        await vi.waitFor(() => {
          expect(buttonByText('Arm').disabled).toBe(true)
          expect(buttonByText('Test mode').disabled).toBe(true)
        })
        // The session-level guards are authoritative even past the buttons.
        session.arm()
        expect(session.phase).toBe('setup')
        session.startTestMode()
        expect(session.phase).toBe('setup')

        orientation.rotateTo('portrait')
        await vi.waitFor(() => expect(text()).not.toContain(WARNING))
        await vi.waitFor(() => expect(buttonByText('Arm').disabled).toBe(false))
        buttonByText('Arm').click()
        await waitForText('ARMED')
      },
      45000,
    )

    it(
      'a fresh camera start rebinds to the current orientation',
      async () => {
        const orientation = new FakeOrientationQuery()
        const session = await mountFlow(orientation)

        await startCameraAndWaitForArm()
        orientation.rotateTo('landscape')
        await waitForText(WARNING)

        // Stopping the camera releases the binding (no ROI in use)…
        buttonByText('Stop camera').click()
        await vi.waitFor(() => expect(session.boundOrientation).toBeNull())
        await vi.waitFor(() => expect(text()).not.toContain(WARNING))

        // …and restarting binds to the orientation the device is in NOW.
        buttonByText('Start camera').click()
        await vi.waitFor(() => expect(session.boundOrientation).toBe('landscape'), {
          timeout: 15000,
        })
        expect(session.orientationMismatch).toBe(false)
      },
      45000,
    )
  },
)
