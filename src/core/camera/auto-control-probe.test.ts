import { describe, expect, it } from 'vitest'
import {
  AUTO_CONTROLS,
  probeAutoControls,
  type AutoControlConstraints,
  type AutoControlModes,
  type AutoControlName,
  type AutoControlResult,
  type AutoControlSettings,
  type AutoControlTrackLike,
} from './auto-control-probe'

const namedError = (name: string, message: string) => Object.assign(new Error(message), { name })

function appliedMode(constraints: AutoControlConstraints): [AutoControlName, string] {
  expect(constraints.advanced).toHaveLength(1)
  const entries = Object.entries(constraints.advanced[0])
  expect(entries).toHaveLength(1)
  return entries[0] as [AutoControlName, string]
}

function fullSupportTrack(options: { reflectApplied?: boolean; failFor?: AutoControlName } = {}) {
  const { reflectApplied = true, failFor } = options
  const settings: AutoControlSettings = {
    exposureMode: 'continuous',
    focusMode: 'continuous',
    whiteBalanceMode: 'continuous',
  }
  const applied: Array<[AutoControlName, string]> = []
  const track: AutoControlTrackLike = {
    getCapabilities: () => ({
      exposureMode: ['continuous', 'manual'],
      focusMode: ['continuous', 'manual'],
      whiteBalanceMode: ['continuous', 'manual'],
    }),
    getSettings: () => ({ ...settings }),
    applyConstraints: async (constraints) => {
      const [control, mode] = appliedMode(constraints)
      if (control === failFor) throw namedError('OverconstrainedError', control)
      applied.push([control, mode])
      if (reflectApplied) settings[control] = mode
    },
  }
  return { track, applied, settings }
}

function findControl(controls: AutoControlResult[], name: AutoControlName) {
  const found = controls.find((entry) => entry.control === name)
  if (!found) throw new Error(`control ${name} missing from report`)
  return found
}

describe('probeAutoControls with full support', () => {
  it('locks each control to manual and reports the reflected settings', async () => {
    const { track } = fullSupportTrack()
    const report = await probeAutoControls(track)

    expect(report.capabilitiesExposed).toBe(true)
    expect(report.controls.map((entry) => entry.control)).toEqual([...AUTO_CONTROLS])
    for (const control of report.controls) {
      expect(control).toMatchObject({
        advertisedModes: ['continuous', 'manual'],
        initialValue: 'continuous',
        lock: { attempted: true, ok: true },
        valueAfterLock: 'manual',
        settingsReflectLock: true,
      })
    }
  })

  it('restores continuous after locking when that was the starting mode', async () => {
    const { track, applied, settings } = fullSupportTrack()
    const report = await probeAutoControls(track)

    expect(applied).toEqual(
      AUTO_CONTROLS.flatMap((control) => [
        [control, 'manual'],
        [control, 'continuous'],
      ]),
    )
    expect(settings).toEqual({
      exposureMode: 'continuous',
      focusMode: 'continuous',
      whiteBalanceMode: 'continuous',
    })
    for (const control of report.controls) {
      expect(control.restore).toEqual({ attempted: true, ok: true })
      expect(control.valueAfterRestore).toBe('continuous')
    }
  })

  it('skips the restore when the starting mode was not continuous', async () => {
    const { track, settings } = fullSupportTrack()
    settings.focusMode = 'single-shot'
    const report = await probeAutoControls(track)

    const focus = findControl(report.controls, 'focusMode')
    expect(focus).toMatchObject({
      initialValue: 'single-shot',
      lock: { attempted: true, ok: true },
      restore: { attempted: false, ok: false },
    })
    const exposure = findControl(report.controls, 'exposureMode')
    expect(exposure.restore).toEqual({ attempted: true, ok: true })
  })
})

describe('probeAutoControls degraded platforms', () => {
  it('reports not-exposed controls without attempting a lock', async () => {
    const applied: unknown[] = []
    const track: AutoControlTrackLike = {
      getCapabilities: () => ({}),
      getSettings: () => ({}),
      applyConstraints: async (constraints) => {
        applied.push(constraints)
      },
    }
    const report = await probeAutoControls(track)

    expect(report.capabilitiesExposed).toBe(true)
    expect(applied).toEqual([])
    for (const control of report.controls) {
      expect(control).toMatchObject({
        advertisedModes: 'not-exposed',
        lock: { attempted: false, ok: false },
        restore: { attempted: false, ok: false },
      })
    }
  })

  it('does not attempt a lock when manual is not among the advertised modes', async () => {
    const applied: unknown[] = []
    const track: AutoControlTrackLike = {
      getCapabilities: () => ({ focusMode: ['continuous', 'single-shot'] }),
      getSettings: () => ({ focusMode: 'continuous' }),
      applyConstraints: async (constraints) => {
        applied.push(constraints)
      },
    }
    const report = await probeAutoControls(track)

    expect(applied).toEqual([])
    expect(findControl(report.controls, 'focusMode')).toMatchObject({
      advertisedModes: ['continuous', 'single-shot'],
      initialValue: 'continuous',
      lock: { attempted: false, ok: false },
    })
  })

  it('handles getCapabilities being absent entirely', async () => {
    const report = await probeAutoControls({})
    expect(report.capabilitiesExposed).toBe(false)
    expect(report.capabilitiesError).toBeUndefined()
    for (const control of report.controls) {
      expect(control.advertisedModes).toBe('not-exposed')
      expect(control.lock).toEqual({ attempted: false, ok: false })
    }
  })

  it('handles getCapabilities throwing', async () => {
    const track: AutoControlTrackLike = {
      getCapabilities: () => {
        throw namedError('InvalidStateError', 'track ended')
      },
    }
    const report = await probeAutoControls(track)
    expect(report.capabilitiesExposed).toBe(false)
    expect(report.capabilitiesError).toBe('InvalidStateError: track ended')
  })

  it('records an applyConstraints failure and still probes the other controls', async () => {
    const { track } = fullSupportTrack({ failFor: 'focusMode' })
    const report = await probeAutoControls(track)

    expect(findControl(report.controls, 'focusMode')).toMatchObject({
      lock: { attempted: true, ok: false, error: 'OverconstrainedError: focusMode' },
      valueAfterLock: 'continuous',
      settingsReflectLock: false,
    })
    for (const name of ['exposureMode', 'whiteBalanceMode'] as const) {
      expect(findControl(report.controls, name)).toMatchObject({
        lock: { attempted: true, ok: true },
        settingsReflectLock: true,
      })
    }
  })

  it('reports when applyConstraints resolves but settings do not reflect the lock', async () => {
    const { track } = fullSupportTrack({ reflectApplied: false })
    const report = await probeAutoControls(track)

    for (const control of report.controls) {
      expect(control).toMatchObject({
        lock: { attempted: true, ok: true },
        valueAfterLock: 'continuous',
        settingsReflectLock: false,
      })
    }
  })

  it('reports a missing applyConstraints as an unattempted lock with a reason', async () => {
    const track: AutoControlTrackLike = {
      getCapabilities: () => ({ exposureMode: ['continuous', 'manual'] }),
      getSettings: () => ({ exposureMode: 'continuous' }),
    }
    const report = await probeAutoControls(track)
    expect(findControl(report.controls, 'exposureMode')).toMatchObject({
      lock: { attempted: false, ok: false, error: 'applyConstraints is not available' },
    })
  })

  it('tolerates getSettings being absent', async () => {
    const applied: unknown[] = []
    const track: AutoControlTrackLike = {
      getCapabilities: () => ({ exposureMode: ['continuous', 'manual'] }),
      applyConstraints: async (constraints) => {
        applied.push(constraints)
      },
    }
    const report = await probeAutoControls(track)
    const exposure = findControl(report.controls, 'exposureMode')
    expect(exposure).toMatchObject({
      initialValue: undefined,
      lock: { attempted: true, ok: true },
      valueAfterLock: undefined,
      settingsReflectLock: false,
      restore: { attempted: false, ok: false },
    })
    expect(applied).toHaveLength(1)
  })

  it('ignores non-string-array capability values', async () => {
    const weird = { exposureMode: 'manual' } as unknown as AutoControlModes
    const track: AutoControlTrackLike = { getCapabilities: () => weird }
    const report = await probeAutoControls(track)
    expect(findControl(report.controls, 'exposureMode').advertisedModes).toBe('not-exposed')
  })
})

describe('probeAutoControls report shape', () => {
  it('is plain serializable data (JSON round-trips losslessly)', async () => {
    const { track } = fullSupportTrack({ failFor: 'whiteBalanceMode' })
    const report = await probeAutoControls(track)
    expect(JSON.parse(JSON.stringify(report))).toEqual(report)
  })
})
