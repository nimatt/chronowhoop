export const AUTO_CONTROLS = ['exposureMode', 'focusMode', 'whiteBalanceMode'] as const
export type AutoControlName = (typeof AUTO_CONTROLS)[number]

// TS's DOM lib does not declare the image-capture controls on
// MediaTrackCapabilities/MediaTrackSettings/MediaTrackConstraintSet, so these
// types extend the DOM ones with the missing fields. Extending (not just
// mirroring) keeps a real MediaStreamTrack assignable to AutoControlTrackLike:
// with no shared properties, TS's weak-type check would reject the DOM types.
export interface AutoControlModes extends MediaTrackCapabilities {
  exposureMode?: string[]
  focusMode?: string[]
  whiteBalanceMode?: string[]
}

export interface AutoControlSettings extends MediaTrackSettings {
  exposureMode?: string
  focusMode?: string
  whiteBalanceMode?: string
}

export type AutoControlConstraintSet = MediaTrackConstraintSet &
  Partial<Record<AutoControlName, string>>

export interface AutoControlConstraints {
  advanced: AutoControlConstraintSet[]
}

export interface AutoControlTrackLike {
  getCapabilities?(): AutoControlModes
  getSettings?(): AutoControlSettings
  applyConstraints?(constraints: AutoControlConstraints): Promise<void>
}

export interface AutoControlApplyAttempt {
  attempted: boolean
  ok: boolean
  error?: string
}

export interface AutoControlResult {
  control: AutoControlName
  advertisedModes: string[] | 'not-exposed'
  initialValue?: string
  lock: AutoControlApplyAttempt
  valueAfterLock?: string
  settingsReflectLock?: boolean
  restore: AutoControlApplyAttempt
  valueAfterRestore?: string
}

// Plain serializable data: this feeds the /diag panel and is copied verbatim
// into the device-matrix report.
export interface AutoControlProbeReport {
  capabilitiesExposed: boolean
  capabilitiesError?: string
  controls: AutoControlResult[]
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.name && error.name !== 'Error' ? `${error.name}: ${error.message}` : error.message
  }
  return String(error)
}

function readSetting(track: AutoControlTrackLike, control: AutoControlName): string | undefined {
  if (typeof track.getSettings !== 'function') return undefined
  try {
    const value = track.getSettings()[control]
    return typeof value === 'string' ? value : undefined
  } catch {
    return undefined
  }
}

async function applyMode(
  track: AutoControlTrackLike,
  control: AutoControlName,
  mode: string,
): Promise<AutoControlApplyAttempt> {
  if (typeof track.applyConstraints !== 'function') {
    return { attempted: false, ok: false, error: 'applyConstraints is not available' }
  }
  try {
    await track.applyConstraints({ advanced: [{ [control]: mode }] })
    return { attempted: true, ok: true }
  } catch (error) {
    return { attempted: true, ok: false, error: describeError(error) }
  }
}

const NOT_ATTEMPTED: AutoControlApplyAttempt = { attempted: false, ok: false }

async function probeControl(
  track: AutoControlTrackLike,
  control: AutoControlName,
  capabilities: AutoControlModes | undefined,
): Promise<AutoControlResult> {
  const advertised = capabilities?.[control]
  const advertisedModes = Array.isArray(advertised) ? advertised.map(String) : ('not-exposed' as const)
  const initialValue = readSetting(track, control)

  if (advertisedModes === 'not-exposed' || !advertisedModes.includes('manual')) {
    return {
      control,
      advertisedModes,
      initialValue,
      lock: { ...NOT_ATTEMPTED },
      restore: { ...NOT_ATTEMPTED },
    }
  }

  const lock = await applyMode(track, control, 'manual')
  const valueAfterLock = readSetting(track, control)
  const settingsReflectLock = valueAfterLock === 'manual'

  // Leave-state policy: restore only when the starting mode was 'continuous';
  // any other starting value is left at the post-lock state and reported.
  if (initialValue !== 'continuous' || !lock.attempted) {
    return {
      control,
      advertisedModes,
      initialValue,
      lock,
      valueAfterLock,
      settingsReflectLock,
      restore: { ...NOT_ATTEMPTED },
    }
  }

  const restore = await applyMode(track, control, 'continuous')
  return {
    control,
    advertisedModes,
    initialValue,
    lock,
    valueAfterLock,
    settingsReflectLock,
    restore,
    valueAfterRestore: readSetting(track, control),
  }
}

// Locks are applied via `advanced` constraint sets, one control per
// applyConstraints call, sequentially — so an OverconstrainedError on one
// control cannot mask or fail the others.
export async function probeAutoControls(track: AutoControlTrackLike): Promise<AutoControlProbeReport> {
  let capabilities: AutoControlModes | undefined
  let capabilitiesError: string | undefined
  if (typeof track.getCapabilities === 'function') {
    try {
      capabilities = track.getCapabilities()
    } catch (error) {
      capabilitiesError = describeError(error)
    }
  }

  const controls: AutoControlResult[] = []
  for (const control of AUTO_CONTROLS) {
    controls.push(await probeControl(track, control, capabilities))
  }

  const report: AutoControlProbeReport = { capabilitiesExposed: capabilities !== undefined, controls }
  if (capabilitiesError !== undefined) report.capabilitiesError = capabilitiesError
  return report
}
