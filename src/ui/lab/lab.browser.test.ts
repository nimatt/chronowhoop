import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount } from 'svelte'
import Lab from '../screens/Lab.svelte'
import type { CameraMediaDevicesLike } from '../../core/camera/camera-service'
import { defaultMediaStreamTrackProcessor } from '../../core/detection/capture-support'
import { decodeClip, encodeClip } from '../../core/detection/clip-format'
import type { LumaFrame } from '../../core/detection/types'

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

function testClipBytes(): Uint8Array {
  const frames: LumaFrame[] = [0, 16, 33].map((captureTimeMs, index) => ({
    data: new Uint8Array(8 * 6).fill(index * 40),
    width: 8,
    height: 6,
    captureTimeMs,
  }))
  return encodeClip(frames, { scene: 'browser-test' })
}

function chooseFile(input: HTMLInputElement, file: File) {
  const transfer = new DataTransfer()
  transfer.items.add(file)
  input.files = transfer.files
  // bubbles: Svelte 5 delegates `change` at the root, so a non-bubbling
  // synthetic event would never reach the component handler.
  input.dispatchEvent(new Event('change', { bubbles: true }))
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

describe('Lab screen', () => {
  it('renders every panel idle without touching the camera, and the self-test passes', async () => {
    // Spy before mount: the lab session constructs its CameraService eagerly
    // but must only call getUserMedia on the Start gesture.
    const getUserMedia = vi.spyOn(navigator.mediaDevices, 'getUserMedia')

    instance = mount(Lab, { target: container })

    await waitForText('Detection pipeline lab')
    for (const heading of [
      'Live pipeline',
      'Tunables',
      'Test mode',
      'Recorder',
      'Annotation stepper',
      'Self-test',
    ]) {
      expect(text()).toContain(heading)
    }
    expect(text()).toContain('Start the camera to run the live pipeline')
    expect(text()).toContain('Load a recorded .cwclip')

    // Test mode and the trigger suggestion need a running capture.
    expect(buttonByText('Start test mode').disabled).toBe(true)
    expect(buttonByText('Stop test mode').disabled).toBe(true)
    expect(buttonByText('Suggest trigger').disabled).toBe(true)

    // The self-test auto-runs: fetch of the bundled fixture asset + pure
    // compute — a real end-to-end check that the served bundle computes what
    // CI computed.
    await waitForText('30 frames bit-exact')
    expect(text()).toContain('PASS')

    expect(getUserMedia).not.toHaveBeenCalled()
  })

  it('annotation stepper loads a clip from bytes, steps frames, and lists a marked crossing', async () => {
    instance = mount(Lab, { target: container })
    await waitForText('Annotation stepper')

    const clipInput = container.querySelector<HTMLInputElement>('input[accept=".cwclip"]')
    expect(clipInput).not.toBeNull()
    chooseFile(clipInput!, new File([testClipBytes() as BlobPart], 'hand-wave.cwclip'))

    await waitForText('hand-wave.cwclip')
    expect(text()).toContain('8×6, 3')
    expect(text()).toMatch(/frame\s*0\s*\/\s*2/)

    buttonByText('+1').click()
    await waitForText('16.00 ms')
    expect(text()).toMatch(/frame\s*1\s*\/\s*2/)

    buttonByText('Mark crossing here').click()
    await vi.waitFor(() => expect(text()).not.toContain('No crossings marked yet'))
    expect(text()).toMatch(/frame\s*1\s*—\s*ltr/)
  })

  it('annotation stepper surfaces a malformed clip as a format error', async () => {
    instance = mount(Lab, { target: container })
    await waitForText('Annotation stepper')

    const clipInput = container.querySelector<HTMLInputElement>('input[accept=".cwclip"]')
    chooseFile(clipInput!, new File([new Uint8Array([1, 2, 3]) as BlobPart], 'broken.cwclip'))

    await waitForText('truncated clip')
  })
})

// Real capture wiring, Chromium only: MediaStreamTrackProcessor (which
// CameraSource is built on) does not exist in WebKit, so the webkit browser
// project skips this block — exactly the app's own support gate.
describe.runIf(typeof defaultMediaStreamTrackProcessor() === 'function')(
  'Lab screen live capture (canvas captureStream behind the mediaDevices seam)',
  () => {
    let disposeScene: (() => void) | undefined

    function startAnimatedScene() {
      const canvas = document.createElement('canvas')
      canvas.width = 320
      canvas.height = 180
      document.body.appendChild(canvas)
      const ctx = canvas.getContext('2d')!
      let x = 0
      const draw = () => {
        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        ctx.fillStyle = '#fff'
        x = (x + 9) % (canvas.width - 40)
        ctx.fillRect(x, 70, 40, 40)
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
      return { stream, mediaDevices }
    }

    afterEach(() => {
      disposeScene?.()
      disposeScene = undefined
    })

    function buttonStartingWith(prefix: string): HTMLButtonElement {
      const button = Array.from(container.querySelectorAll('button')).find((candidate) =>
        candidate.textContent?.trim().startsWith(prefix),
      )
      if (!button) throw new Error(`no button starting with ${JSON.stringify(prefix)}`)
      return button
    }

    // The live panel renders CameraSource stats as "{read} / {emitted} / {errors}"
    // in a single dd; parse it back out.
    function emittedCount(): number {
      for (const dd of container.querySelectorAll('dd')) {
        const match = /^(\d+) \/ (\d+) \/ (\d+)$/.exec(dd.textContent?.trim() ?? '')
        if (match) return Number(match[2])
      }
      return -1
    }

    it(
      'starts real capture, emits FrameSamples, exports a decodable ring clip, and stops',
      async () => {
        const { mediaDevices } = startAnimatedScene()
        const capturedBlobs: Blob[] = []
        const realCreateObjectURL = URL.createObjectURL.bind(URL)
        vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
          if (blob instanceof Blob) capturedBlobs.push(blob)
          return realCreateObjectURL(blob)
        })
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

        instance = mount(Lab, { target: container, props: { mediaDevices } })
        await waitForText('Start the camera to run the live pipeline')

        buttonByText('Start camera + pipeline').click()

        // Stats snapshots poll at 1 Hz; emitted > 0 proves the whole chain
        // ran: captureStream track → MSTP → CameraSource → tee → pipeline.
        await vi.waitFor(() => expect(emittedCount()).toBeGreaterThan(0), { timeout: 15000 })

        buttonStartingWith('Save ring clip').click()
        await vi.waitFor(() => expect(capturedBlobs.length).toBeGreaterThan(0))
        const bytes = new Uint8Array(await capturedBlobs[0].arrayBuffer())
        const { header, frames } = decodeClip(bytes)
        expect(frames.length).toBeGreaterThan(0)
        expect(header.frameCount).toBe(frames.length)
        expect(frames[0].width).toBe(header.width)
        expect(frames[0].height).toBe(header.height)
        expect(frames[0].data.length).toBe(header.width * header.height)

        buttonByText('Stop').click()
        await vi.waitFor(() =>
          expect(buttonByText('Start camera + pipeline').disabled).toBe(false),
        )
        expect(buttonByText('Stop').disabled).toBe(true)
      },
      30000,
    )

    it(
      'test mode arms over live capture, suggest-trigger applies a level, and capture stop auto-stops it',
      async () => {
        const { mediaDevices } = startAnimatedScene()
        instance = mount(Lab, { target: container, props: { mediaDevices } })
        await waitForText('Start the camera to run the live pipeline')

        buttonByText('Start camera + pipeline').click()
        await vi.waitFor(() => expect(emittedCount()).toBeGreaterThan(0), { timeout: 15000 })
        await vi.waitFor(() => expect(buttonByText('Start test mode').disabled).toBe(false))

        buttonByText('Start test mode').click()
        await vi.waitFor(() => expect(buttonByText('Stop test mode').disabled).toBe(false))
        expect(buttonByText('Start test mode').disabled).toBe(true)
        // The live crossingInProgress indicator renders only while armed.
        await waitForText('crossing:')

        // The suggestion needs ~3 s of observed capture time; the moving-block
        // scene is not quiet, so only the value's existence (and its clamped
        // range) is deterministic — not its magnitude.
        buttonByText('Suggest trigger').click()
        await vi.waitFor(() => expect(text()).toContain('suggested trigger level'), {
          timeout: 20000,
        })
        const match = /suggested trigger level:\s*([\d.]+)/.exec(text())
        expect(match).not.toBeNull()
        const suggested = Number(match![1])
        expect(suggested).toBeGreaterThanOrEqual(0.02)
        expect(suggested).toBeLessThanOrEqual(0.5)

        // Apply routes the suggestion into the shared tunables (the trigger
        // slider is the only range input with max="1").
        buttonByText('Apply').click()
        const triggerSlider = container.querySelector<HTMLInputElement>(
          'input[type="range"][max="1"]',
        )
        expect(triggerSlider).not.toBeNull()
        await vi.waitFor(() => expect(Number(triggerSlider!.value)).toBeCloseTo(suggested, 2))

        // Stopping capture auto-stops test mode.
        buttonByText('Stop').click()
        await vi.waitFor(() => expect(buttonByText('Stop test mode').disabled).toBe(true))
        expect(buttonByText('Start test mode').disabled).toBe(true)
      },
      45000,
    )

    it(
      'test mode arms and stays alive at the trigger slider minimum',
      async () => {
        const { mediaDevices } = startAnimatedScene()
        instance = mount(Lab, { target: container, props: { mediaDevices } })
        await waitForText('Start the camera to run the live pipeline')

        buttonByText('Start camera + pipeline').click()
        await vi.waitFor(() => expect(emittedCount()).toBeGreaterThan(0), { timeout: 15000 })
        await vi.waitFor(() => expect(buttonByText('Start test mode').disabled).toBe(false))

        // CrossingDetector rejects triggerLevel ≤ 0, so the slider minimum
        // must stay above 0 — and arming at that minimum must not throw.
        const triggerSlider = container.querySelector<HTMLInputElement>(
          'input[type="range"][max="1"]',
        )
        expect(triggerSlider).not.toBeNull()
        expect(Number(triggerSlider!.min)).toBeGreaterThan(0)
        triggerSlider!.value = triggerSlider!.min
        triggerSlider!.dispatchEvent(new Event('input', { bubbles: true }))

        buttonByText('Start test mode').click()
        await vi.waitFor(() => expect(buttonByText('Stop test mode').disabled).toBe(false))
        await waitForText('crossing:')

        // Dragging away and back to the minimum while armed routes through
        // the live-tracking effect; the panel must survive it.
        triggerSlider!.value = '0.5'
        triggerSlider!.dispatchEvent(new Event('input', { bubbles: true }))
        triggerSlider!.value = triggerSlider!.min
        triggerSlider!.dispatchEvent(new Event('input', { bubbles: true }))
        await vi.waitFor(() =>
          expect(Number(triggerSlider!.value)).toBeCloseTo(Number(triggerSlider!.min), 4),
        )
        expect(buttonByText('Stop test mode').disabled).toBe(false)
        expect(text()).toContain('crossing:')

        buttonByText('Stop').click()
        await vi.waitFor(() => expect(buttonByText('Stop test mode').disabled).toBe(true))
      },
      30000,
    )

    it(
      'external track death tears capture down and surfaces track-ended',
      async () => {
        const { stream, mediaDevices } = startAnimatedScene()
        instance = mount(Lab, { target: container, props: { mediaDevices } })
        await waitForText('Start the camera to run the live pipeline')

        buttonByText('Start camera + pipeline').click()
        await vi.waitFor(() => expect(emittedCount()).toBeGreaterThan(0), { timeout: 15000 })

        // MediaStreamTrack.stop() deliberately fires no 'ended' event, so the
        // external death (revocation, device loss) is simulated by dispatching
        // the event the platform would dispatch.
        stream.getVideoTracks()[0].dispatchEvent(new Event('ended'))

        await waitForText('track-ended')
        await vi.waitFor(() => expect(buttonByText('Stop').disabled).toBe(true))
        expect(buttonByText('Start camera + pipeline').disabled).toBe(false)
        expect(text()).toContain('capture stopped')
      },
      30000,
    )
  },
)
