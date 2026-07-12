import { probeOpfs } from '../storage/opfs-probe'

export type ProbeOutcome = { ok: true } | { ok: false; detail: string }

export type CapabilityName = 'webgpu' | 'camera' | 'opfs' | 'speech'

export interface CapabilityResult {
  name: CapabilityName
  label: string
  required: boolean
  ok: boolean
  detail?: string
}

export interface CapabilityReport {
  ok: boolean
  capabilities: CapabilityResult[]
}

interface GpuDeviceLike {
  destroy?(): void
}

export interface GpuAdapterLike {
  requestDevice(): Promise<GpuDeviceLike>
}

export interface GpuLike {
  requestAdapter(): Promise<GpuAdapterLike | null>
}

function defaultGpu(): GpuLike | undefined {
  const global = globalThis as { navigator?: { gpu?: GpuLike } }
  return global.navigator?.gpu
}

export async function probeWebGpu(gpu: GpuLike | undefined = defaultGpu()): Promise<ProbeOutcome> {
  if (typeof gpu?.requestAdapter !== 'function') {
    return { ok: false, detail: 'navigator.gpu is not available' }
  }
  const adapter = await gpu.requestAdapter()
  if (!adapter) {
    return { ok: false, detail: 'requestAdapter() returned no adapter' }
  }
  // Requests default limits for now; Phase 3 revisits requested limits once
  // the detection pipeline's actual needs (buffer sizes, workgroup limits) are known.
  const device = await adapter.requestDevice()
  device.destroy?.()
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
  webgpu(): Promise<ProbeOutcome>
  camera(): Promise<ProbeOutcome>
  opfs(): Promise<ProbeOutcome>
  speech(): Promise<ProbeOutcome>
}

// Every capability is currently a hard requirement — product.md's "Platform
// requirements" and ADR 0002 gate startup on all four. The `required` flag makes
// that policy explicit (and gives a seam for graceful degradation later) rather
// than baking "all-or-nothing" into the gate computation.
const capabilityMeta: Record<CapabilityName, { label: string; required: boolean }> = {
  webgpu: { label: 'WebGPU', required: true },
  camera: { label: 'Camera (getUserMedia)', required: true },
  opfs: { label: 'Local storage (OPFS)', required: true },
  speech: { label: 'Speech synthesis', required: true },
}

const defaultProbes: CapabilityProbes = {
  webgpu: () => probeWebGpu(),
  camera: () => probeCamera(),
  opfs: probeOpfsCapability,
  speech: () => probeSpeech(),
}

// A hung probe (a `requestAdapter()`/`getDirectory()` that never settles) would
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
  const { label, required } = capabilityMeta[name]
  let outcome: ProbeOutcome
  try {
    outcome = await withTimeout(probe(), timeoutMs)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { name, label, required, ok: false, detail: `probe threw: ${message}` }
  }
  return outcome.ok
    ? { name, label, required, ok: true }
    : { name, label, required, ok: false, detail: outcome.detail }
}

export async function checkCapabilities(
  probes: Partial<CapabilityProbes> = {},
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<CapabilityReport> {
  const merged = { ...defaultProbes, ...probes }
  const capabilities = await Promise.all([
    runProbe('webgpu', merged.webgpu, timeoutMs),
    runProbe('camera', merged.camera, timeoutMs),
    runProbe('opfs', merged.opfs, timeoutMs),
    runProbe('speech', merged.speech, timeoutMs),
  ])
  const ok = capabilities.filter((capability) => capability.required).every((capability) => capability.ok)
  return { ok, capabilities }
}
