import { defaultMediaStreamTrackProcessor } from '../detection/capture-support'
import { probeOpfs } from '../storage/opfs-probe'

export type ProbeOutcome = { ok: true } | { ok: false; detail: string }

export type CapabilityName = 'webcodecs' | 'camera' | 'opfs' | 'speech'

export interface CapabilityResult {
  name: CapabilityName
  label: string
  ok: boolean
  detail?: string
}

export interface CapabilityReport {
  ok: boolean
  capabilities: CapabilityResult[]
}

// Presence check only: constructing a processor needs a live camera track,
// which the gate must not request. The parameter is the constructor value
// itself (structurally `unknown`) so tests inject fakes.
export async function probeWebCodecs(
  trackProcessor: unknown = defaultMediaStreamTrackProcessor(),
): Promise<ProbeOutcome> {
  if (typeof trackProcessor !== 'function') {
    return { ok: false, detail: 'MediaStreamTrackProcessor is not available' }
  }
  return { ok: true }
}

export interface MediaDevicesLike {
  getUserMedia?: unknown
}

function defaultMediaDevices(): MediaDevicesLike | undefined {
  const global = globalThis as { navigator?: { mediaDevices?: MediaDevicesLike } }
  return global.navigator?.mediaDevices
}

export async function probeCamera(
  mediaDevices: MediaDevicesLike | undefined = defaultMediaDevices(),
): Promise<ProbeOutcome> {
  if (typeof mediaDevices?.getUserMedia !== 'function') {
    return { ok: false, detail: 'navigator.mediaDevices.getUserMedia is not available' }
  }
  return { ok: true }
}

export async function probeSpeech(
  speechSynthesis: unknown = (globalThis as { speechSynthesis?: unknown }).speechSynthesis,
): Promise<ProbeOutcome> {
  if (speechSynthesis === undefined || speechSynthesis === null) {
    return { ok: false, detail: 'speechSynthesis is not available' }
  }
  return { ok: true }
}

async function probeOpfsCapability(): Promise<ProbeOutcome> {
  const result = await probeOpfs()
  return result.ok ? { ok: true } : { ok: false, detail: result.message }
}

export interface CapabilityProbes {
  webcodecs(): Promise<ProbeOutcome>
  camera(): Promise<ProbeOutcome>
  opfs(): Promise<ProbeOutcome>
  speech(): Promise<ProbeOutcome>
}

// Every capability is a hard requirement: product.md's "Platform requirements"
// and ADR 0009 gate startup on all four.
const capabilityLabels: Record<CapabilityName, string> = {
  webcodecs: 'WebCodecs capture (MediaStreamTrackProcessor)',
  camera: 'Camera (getUserMedia)',
  opfs: 'Local storage (OPFS)',
  speech: 'Speech synthesis',
}

const defaultProbes: CapabilityProbes = {
  webcodecs: () => probeWebCodecs(),
  camera: () => probeCamera(),
  opfs: probeOpfsCapability,
  speech: () => probeSpeech(),
}

// A hung probe (a `getDirectory()` that never settles) would
// otherwise leave the report null forever, stranding the app on its loading
// state. Bound every probe so the gate always resolves.
export const DEFAULT_PROBE_TIMEOUT_MS = 8000

function withTimeout(promise: Promise<ProbeOutcome>, timeoutMs: number): Promise<ProbeOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<ProbeOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, detail: 'probe timed out' }), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function runProbe(
  name: CapabilityName,
  probe: () => Promise<ProbeOutcome>,
  timeoutMs: number,
): Promise<CapabilityResult> {
  const label = capabilityLabels[name]
  let outcome: ProbeOutcome
  try {
    outcome = await withTimeout(probe(), timeoutMs)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { name, label, ok: false, detail: `probe threw: ${message}` }
  }
  return outcome.ok
    ? { name, label, ok: true }
    : { name, label, ok: false, detail: outcome.detail }
}

export async function checkCapabilities(
  probes: Partial<CapabilityProbes> = {},
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<CapabilityReport> {
  const merged = { ...defaultProbes, ...probes }
  const capabilities = await Promise.all([
    runProbe('webcodecs', merged.webcodecs, timeoutMs),
    runProbe('camera', merged.camera, timeoutMs),
    runProbe('opfs', merged.opfs, timeoutMs),
    runProbe('speech', merged.speech, timeoutMs),
  ])
  const ok = capabilities.every((capability) => capability.ok)
  return { ok, capabilities }
}
