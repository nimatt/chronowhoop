import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount } from 'svelte'
import Fly from '../screens/Fly.svelte'
import SessionView from '../screens/SessionView.svelte'
import type { CameraMediaDevicesLike } from '../../core/camera/camera-service'
import type { Session } from '../../core/domain/types'
import { defaultMediaStreamTrackProcessor } from '../../core/detection/capture-support'
import { MemoryStorage } from '../../core/storage/memory-storage'
import { OpfsStorage } from '../../core/storage/opfs-storage'
import { makeCourse } from '../../core/storage/storage-contract'
import type { Storage } from '../../core/storage/storage'
import { createStorageContext } from '../data/storage-context.svelte'
import type { StorageContext } from '../data/storage-context'
import type { FlySession } from './fly-session'

const COURSE = makeCourse({
  id: 'course-fly',
  name: 'Basement 3-gate',
  direction: 'ltr',
  minLapTimeMs: 3000,
})

let container: HTMLElement
let instance: ReturnType<typeof mount> | undefined
const contexts: StorageContext[] = []

const READ_ONLY_BANNER = 'Read-only: another tab is active'

// FlyFlow reads a live `readOnly` boolean straight off the storage instance
// when it exposes one (OpfsStorage's Web Locks answer); this fake lets tests
// flip it at will without origin-global locks.
class FlaggableStorage extends MemoryStorage {
  readOnly = false
}

// saveSession blocks behind an on-demand gate — how the re-arm gate is
// exercised with a write still in flight.
class GateableStorage extends MemoryStorage {
  #gate: Promise<void> | null = null
  #open: (() => void) | null = null

  holdWrites(): void {
    this.#gate = new Promise((resolve) => {
      this.#open = resolve
    })
  }

  releaseWrites(): void {
    this.#open?.()
    this.#gate = null
    this.#open = null
  }

  override async saveSession(session: Session): Promise<void> {
    const gate = this.#gate
    if (gate !== null) await gate
    return super.saveSession(session)
  }
}

const text = () => container.textContent ?? ''
const waitForText = (needle: string) => vi.waitFor(() => expect(text()).toContain(needle))

function buttonByText(label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label,
  )
  if (!button) throw new Error(`no button labelled ${JSON.stringify(label)}`)
  return button
}

// Builds a context over the given storage and seeds the fly course; the
// context is destroyed in afterEach (matters for OpfsStorage's writer lock).
async function seededContext(storage: Storage): Promise<StorageContext> {
  const context = createStorageContext({ createStorage: () => storage })
  contexts.push(context)
  if (!(await context.coursesRepo.saveCourse({ ...COURSE }))) {
    throw new Error('failed to seed the fly course')
  }
  return context
}

interface MountFlyOptions {
  mediaDevices?: CameraMediaDevicesLike
  context: StorageContext
}

// The Fly screen resolves its course + prefill before mounting the flow, so
// the session arrives asynchronously via the onsession seam.
async function mountFlyScreen(options: MountFlyOptions): Promise<FlySession> {
  let session: FlySession | undefined
  instance = mount(Fly, {
    target: container,
    props: {
      context: options.context,
      courseId: COURSE.id,
      ...(options.mediaDevices ? { mediaDevices: options.mediaDevices } : {}),
      onsession: (created: FlySession) => (session = created),
    },
  })
  await vi.waitFor(() => expect(session).toBeDefined())
  return session!
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

describe('Fly screen', () => {
  it('renders the setup step idle without touching the camera, arming gated', async () => {
    // Spy before mount: the fly session constructs its CameraService eagerly
    // but must only call getUserMedia on the Start gesture.
    const getUserMedia = vi.spyOn(navigator.mediaDevices, 'getUserMedia')

    const context = await seededContext(new MemoryStorage())
    await mountFlyScreen({ context })

    await waitForText('Basement 3-gate')
    expect(text()).toContain('start the camera')

    // The course owns direction and min lap time — shown read-only with an
    // edit affordance, no inline inputs (product.md setup step).
    expect(text()).toContain('left → right')
    expect(text()).toContain('min lap 3 s')
    expect(text()).toContain('Edit course')
    expect(container.querySelector('select')).toBeNull()

    // Test mode and arming need a running capture (item: Arm gated until
    // camera running).
    expect(buttonByText('Start camera').disabled).toBe(false)
    expect(buttonByText('Test mode').disabled).toBe(true)
    expect(buttonByText('Arm').disabled).toBe(true)

    expect(getUserMedia).not.toHaveBeenCalled()
  })

  it('the speech toggle persists settings.speechEnabled through the storage seam', async () => {
    const storage = new MemoryStorage()
    const context = await seededContext(storage)
    await mountFlyScreen({ context })
    await waitForText('spoken lap times')

    const toggle = container.querySelector<HTMLInputElement>('.speech-toggle input')
    if (!toggle) throw new Error('no speech toggle')
    expect(toggle.checked).toBe(true)

    toggle.click()
    await vi.waitFor(async () => {
      expect((await storage.loadCourses()).settings.speechEnabled).toBe(false)
    })
  })

  it('polls the storage read-only answer: banner and Arm gate follow late flips', async () => {
    const storage = new FlaggableStorage()
    const context = await seededContext(storage)
    await mountFlyScreen({ context })
    await waitForText('Basement 3-gate')
    expect(text()).not.toContain(READ_ONLY_BANNER)

    // The lock answer can flip well after load (delayed re-request); the
    // flow's poll picks it up without any repository operation happening.
    storage.readOnly = true
    await vi.waitFor(() => expect(text()).toContain(READ_ONLY_BANNER), { timeout: 3000 })

    storage.readOnly = false
    await vi.waitFor(() => expect(text()).not.toContain(READ_ONLY_BANNER), { timeout: 3000 })
  })

  it('shows a not-found notice for an unknown course id', async () => {
    const context = createStorageContext({ createStorage: () => new MemoryStorage() })
    contexts.push(context)
    instance = mount(Fly, {
      target: container,
      props: { context, courseId: 'does-not-exist' },
    })
    await waitForText('This course does not exist.')
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

    async function mountFly(mediaDevices: CameraMediaDevicesLike, storage?: Storage) {
      const backing = storage ?? new MemoryStorage()
      const context = await seededContext(backing)
      const session = await mountFlyScreen({ mediaDevices, context })
      return { session, context, storage: backing }
    }

    function setNoteField(value: string) {
      const noteArea = container.querySelector('textarea')
      if (!noteArea) throw new Error('no note field')
      noteArea.value = value
      // The note persists per input event (not blur/change) so Back
      // navigation cannot lose it. Svelte 5 delegates 'input' to the mount
      // root, so it must bubble.
      noteArea.dispatchEvent(new Event('input', { bubbles: true }))
    }

    it(
      'runs setup → armed (session file at arm) → laps → discard → stopped table → note edit → new session',
      async () => {
        const { mediaDevices } = startQuietScene()
        const { session, storage } = await mountFly(mediaDevices)

        await waitForText('Basement 3-gate')
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

        // The session file exists from arm time, before any crossing (a
        // zero-lap crash leaves a recoverable record), and lastCourseId
        // recorded the flown course.
        await vi.waitFor(async () => {
          const summaries = await storage.listSessions()
          expect(summaries.length).toBe(1)
          expect(summaries[0].lapCount).toBe(0)
          expect(summaries[0].courseId).toBe(COURSE.id)
          expect((await storage.loadCourses()).settings.lastCourseId).toBe(COURSE.id)
        })

        // Crossing timestamps live in the capture-time domain — any monotonic
        // ms values work. min lap time comes from the course (3000 ms).
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

        // The persister state surfaces AFTER stop: everything flushed.
        await waitForText('Session saved.')

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

        // The stored session matches the engine's, discard included.
        const [summary] = await storage.listSessions()
        const stored = await storage.loadSession(summary.id)
        expect(stored.laps.map((lap) => [lap.durationMs, lap.status])).toEqual([
          [14320, 'valid'],
          [13330, 'discarded'],
          [16000, 'valid'],
        ])

        // Post-stop note editing persists through the same write path.
        setNoteField('triple gate practice')
        await vi.waitFor(async () => {
          expect((await storage.loadSession(summary.id)).note).toBe('triple gate practice')
        })

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
        const { session } = await mountFly(mediaDevices)

        await waitForText('Basement 3-gate')
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
        const { session } = await mountFly(mediaDevices)

        await waitForText('Basement 3-gate')
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
        const { session } = await mountFly(mediaDevices)

        await waitForText('Basement 3-gate')
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
        const { session } = await mountFly(mediaDevices)

        const clockSeconds = () => {
          const value = container.querySelector('.clock')?.textContent ?? ''
          const match = /^(?:(\d+):)?(\d+)\.(\d)$/.exec(value)
          if (!match) throw new Error(`clock not running: ${JSON.stringify(value)}`)
          const minutes = match[1] === undefined ? 0 : Number(match[1])
          return minutes * 60 + Number(match[2]) + Number(match[3]) / 10
        }

        await waitForText('Basement 3-gate')
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

    it(
      'read-only gates arming: click-time re-check catches a flip the poll has not seen yet',
      async () => {
        const { mediaDevices } = startQuietScene()
        const storage = new FlaggableStorage()
        const { session } = await mountFly(mediaDevices, storage)

        await waitForText('Basement 3-gate')
        buttonByText('Start camera').click()
        await vi.waitFor(() => expect(buttonByText('Arm').disabled).toBe(false), {
          timeout: 15000,
        })

        // Flip read-only and click Arm BEFORE the poll can disable the
        // button: the click handler re-derives the live answer and refuses.
        storage.readOnly = true
        buttonByText('Arm').click()
        // The click-time re-derive refused synchronously (never armed) …
        expect(session.phase).toBe('setup')
        // … and the banner/disable follow on the next render.
        await vi.waitFor(() => {
          expect(text()).toContain(READ_ONLY_BANNER)
          expect(buttonByText('Arm').disabled).toBe(true)
        })

        // Lock regained (the other tab closed): the poll re-enables arming.
        storage.readOnly = false
        await vi.waitFor(() => expect(buttonByText('Arm').disabled).toBe(false), {
          timeout: 3000,
        })
        buttonByText('Arm').click()
        await waitForText('ARMED')
      },
      45000,
    )

    it(
      'a still-saving previous session blocks re-arming with a note until the write settles',
      async () => {
        const { mediaDevices } = startQuietScene()
        const storage = new GateableStorage()
        const { session } = await mountFly(mediaDevices, storage)

        await waitForText('Basement 3-gate')
        buttonByText('Start camera').click()
        await vi.waitFor(() => expect(buttonByText('Arm').disabled).toBe(false), {
          timeout: 15000,
        })

        buttonByText('Arm').click()
        await waitForText('ARMED')
        session.injectCrossing({ timestampMs: 1000, direction: 'ltr' })
        session.injectCrossing({ timestampMs: 15320, direction: 'ltr' }) // lap 1: 14.32
        await waitForText('14.32')
        await vi.waitFor(() => expect(session.persisterState.pending).toBe(false))

        // The next lap's write hangs; Stop leaves the persister pending.
        storage.holdWrites()
        session.injectCrossing({ timestampMs: 28650, direction: 'ltr' }) // lap 2: 13.33
        await waitForText('13.33')
        buttonByText('Stop').click()
        await waitForText('Session over')
        await waitForText('Saving session…')

        // Re-arming now would drop the unsaved tail (persister coalescing is
        // global), so the setup panel gates Arm and says why.
        buttonByText('New session').click()
        await waitForText('Saving previous session…')
        expect(buttonByText('Arm').disabled).toBe(true)
        // The session-level guard is authoritative even past the button.
        session.arm()
        expect(session.phase).toBe('setup')

        storage.releaseWrites()
        await vi.waitFor(() => expect(buttonByText('Arm').disabled).toBe(false))
        expect(text()).not.toContain('Saving previous session…')
        buttonByText('Arm').click()
        await waitForText('ARMED')
      },
      45000,
    )

    // The plan's mid-phase durability checkpoint (plan 06, "fly a persisted
    // session, kill the tab mid-session, reopen, laps survive"), against REAL
    // OPFS: while the flow is still ARMED (no Stop), a brand-new OpfsStorage
    // over the same root — the moral equivalent of reopening after a tab kill
    // — already sees the session file with the completed laps, because the
    // persister wrote at arm and after every lap. At most the last lap is
    // ever lost.
    it(
      'durability checkpoint: a fresh OpfsStorage over the same root sees the laps mid-session, before any Stop',
      async () => {
        const opfsRoot = await navigator.storage.getDirectory()
        const rootName = `chronowhoop-fly-checkpoint-${crypto.randomUUID()}`
        const dir = await opfsRoot.getDirectoryHandle(rootName, { create: true })
        const rootDirectory = () => Promise.resolve(dir)
        const disposables: OpfsStorage[] = []
        try {
          const { mediaDevices } = startQuietScene()
          const writer = new OpfsStorage({ rootDirectory })
          disposables.push(writer)
          const { session } = await mountFly(mediaDevices, writer)

          await waitForText('Basement 3-gate')
          buttonByText('Start camera').click()
          await vi.waitFor(() => expect(buttonByText('Arm').disabled).toBe(false), {
            timeout: 15000,
          })

          buttonByText('Arm').click()
          await waitForText('ARMED')
          session.injectCrossing({ timestampMs: 1000, direction: 'ltr' }) // starts the clock
          session.injectCrossing({ timestampMs: 15320, direction: 'ltr' }) // lap 1: 14.32
          session.injectCrossing({ timestampMs: 28650, direction: 'ltr' }) // lap 2: 13.33
          await waitForText('13.33')

          // WITHOUT stopping: a second OpfsStorage over the same root (it
          // comes up read-only — the live tab holds the writer lock — which
          // is exactly a fresh tab's view after the old one was killed).
          const reopened = new OpfsStorage({ rootDirectory })
          disposables.push(reopened)
          let persistedId = ''
          await vi.waitFor(async () => {
            const summaries = await reopened.listSessions()
            expect(summaries.length).toBe(1)
            // Two laps flown, at least one on disk: never more than the last
            // lap at risk. (In practice both are on disk within a beat.)
            expect(summaries[0].lapCount).toBeGreaterThanOrEqual(1)
            persistedId = summaries[0].id
          })
          const midFlight = await reopened.loadSession(persistedId)
          expect(midFlight.courseId).toBe(COURSE.id)
          expect(midFlight.laps[0]).toMatchObject({ durationMs: 14320, status: 'valid' })

          // Stop → both laps flushed, note edit round-trips to disk.
          buttonByText('Stop').click()
          await waitForText('Session saved.')
          setNoteField('checkpoint note')
          await vi.waitFor(async () => {
            const stored = await reopened.loadSession(persistedId)
            expect(stored.note).toBe('checkpoint note')
            expect(stored.laps.map((lap) => lap.durationMs)).toEqual([14320, 13330])
          })

          // "Reopen": tear the fly tab down (releasing the writer lock) and
          // render the session view from a fresh context over the same root.
          void unmount(instance!)
          instance = undefined
          for (const context of contexts.splice(0)) context.destroy()

          const reopenedContext = createStorageContext({
            createStorage: () => new OpfsStorage({ rootDirectory }),
          })
          contexts.push(reopenedContext)
          instance = mount(SessionView, {
            target: container,
            props: { context: reopenedContext, sessionId: persistedId },
          })
          await waitForText('Basement 3-gate')
          await waitForText('14.32')
          await waitForText('13.33')
          await vi.waitFor(() =>
            expect(container.querySelector('textarea')?.value).toBe('checkpoint note'),
          )
        } finally {
          for (const storage of disposables) storage.dispose()
          await opfsRoot.removeEntry(rootName, { recursive: true }).catch(() => {})
        }
      },
      60000,
    )
  },
)
