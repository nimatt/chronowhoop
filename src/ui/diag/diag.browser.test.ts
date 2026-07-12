import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount } from 'svelte'
import Diag from '../screens/Diag.svelte'

let container: HTMLElement
let instance: ReturnType<typeof mount> | undefined

const text = () => container.textContent ?? ''
const waitForText = (needle: string) => vi.waitFor(() => expect(text()).toContain(needle))

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

describe('Diag screen panels', () => {
  it('renders every panel idle without starting any gesture-driven probe', async () => {
    // Spy before mount: CameraService captures navigator.mediaDevices at
    // construction, but calls getUserMedia through it lazily.
    const getUserMedia = vi.spyOn(navigator.mediaDevices, 'getUserMedia')

    instance = mount(Diag, { target: container })

    await waitForText('Diagnostics')
    for (const heading of [
      'Capabilities',
      'Camera',
      'Frame loop',
      'GPU device',
      'Texture import',
      'Readback benchmark',
      'CPU pipeline',
      'Speech',
      'Storage (OPFS)',
      'Wake lock',
    ]) {
      expect(text()).toContain(heading)
    }

    // Idle states: nothing gesture-driven has started.
    expect(text()).toContain('Camera idle')
    expect(text()).toContain('Start the camera first')
    expect(text()).toContain('no speech activity yet')

    // The pending atomic-write check runs automatically against real OPFS and
    // reports that no experiment was pending.
    await waitForText('No pending atomic-write experiment')

    expect(getUserMedia).not.toHaveBeenCalled()
  })
})
