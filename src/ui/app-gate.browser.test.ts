import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount } from 'svelte'
import App from './App.svelte'
import type { CapabilityReport } from '../core/capabilities/capabilities'
import { MemoryStorage } from '../core/storage/memory-storage'

const failingReport: CapabilityReport = {
  ok: false,
  capabilities: [
    {
      name: 'webcodecs',
      label: 'WebCodecs capture (MediaStreamTrackProcessor)',
      ok: false,
      detail: 'MediaStreamTrackProcessor is not available',
    },
    { name: 'camera', label: 'Camera (getUserMedia)', ok: true },
    { name: 'opfs', label: 'Local storage (OPFS)', ok: true },
    { name: 'speech', label: 'Speech synthesis', ok: true },
  ],
}

const passingReport: CapabilityReport = {
  ok: true,
  capabilities: failingReport.capabilities.map((capability) =>
    capability.name === 'webcodecs' ? { ...capability, ok: true, detail: undefined } : capability,
  ),
}

const pending = () => new Promise<CapabilityReport>(() => {})
const resolved = (report: CapabilityReport) => () => Promise.resolve(report)

let container: HTMLElement
let instance: ReturnType<typeof mount> | undefined

function mountApp(check: () => Promise<CapabilityReport>) {
  // MemoryStorage keeps the gate tests off the real OPFS root and the
  // origin-global writer lock.
  instance = mount(App, {
    target: container,
    props: { check, createStorage: () => new MemoryStorage() },
  })
}

const text = () => container.textContent ?? ''
const waitForText = (needle: string) => vi.waitFor(() => expect(text()).toContain(needle))

function setHash(hash: string) {
  location.hash = hash
}

beforeEach(() => {
  history.replaceState(null, '', location.pathname + location.search)
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  if (instance) {
    void unmount(instance)
    instance = undefined
  }
  container.remove()
})

describe('App capability gate wiring', () => {
  it('while the capability check is pending, home shows the checking state', async () => {
    mountApp(pending)
    await waitForText('Checking browser capabilities')
    expect(text()).not.toContain('Courses')
    expect(text()).not.toContain("can't run ChronoWhoop")
  })

  it('renders /diag and /lab immediately while the check is pending (gate exemption)', async () => {
    setHash('#/diag')
    mountApp(pending)
    await waitForText('Diagnostics')
    expect(text()).not.toContain('Checking browser capabilities')

    void unmount(instance!)
    instance = undefined
    container.remove()
    container = document.createElement('div')
    document.body.appendChild(container)

    setHash('#/lab')
    mountApp(pending)
    await waitForText('Detection pipeline lab')
    expect(text()).not.toContain('Checking browser capabilities')
  })

  it('shows Unsupported with per-capability results on a failing report, and re-shows it after visiting /diag', async () => {
    mountApp(resolved(failingReport))

    await waitForText("This browser can't run ChronoWhoop")
    expect(text()).toContain('WebCodecs')
    expect(text()).toContain('detection capture')
    expect(text()).toContain('MediaStreamTrackProcessor is not available')
    expect(container.querySelectorAll('.probe.fail').length).toBe(1)
    expect(container.querySelectorAll('.probe.pass').length).toBe(3)
    expect(text()).toContain('Open diagnostics')

    setHash('#/diag')
    await waitForText('Diagnostics')
    expect(text()).not.toContain("can't run ChronoWhoop")

    setHash('#/')
    await waitForText("This browser can't run ChronoWhoop")
  })

  it('renders home on an all-pass report', async () => {
    mountApp(resolved(passingReport))
    await waitForText('Courses')
    expect(text()).not.toContain("can't run ChronoWhoop")
    expect(text()).not.toContain('Checking browser capabilities')
  })
})
