import { describe, expect, it } from 'vitest'
import {
  checkCapabilities,
  probeCamera,
  probeSpeech,
  probeWebCodecs,
  type CapabilityProbes,
  type ProbeOutcome,
} from './capabilities'

const pass = async (): Promise<ProbeOutcome> => ({ ok: true })
const fail =
  (detail: string) =>
  async (): Promise<ProbeOutcome> => ({ ok: false, detail })

const allPass: CapabilityProbes = { webcodecs: pass, camera: pass, opfs: pass, speech: pass }

function findCapability(capabilities: { name: string }[], name: string) {
  const found = capabilities.find((capability) => capability.name === name)
  if (!found) throw new Error(`capability ${name} missing from report`)
  return found
}

describe('checkCapabilities', () => {
  it('reports overall ok when every probe passes', async () => {
    const report = await checkCapabilities(allPass)
    expect(report.ok).toBe(true)
    expect(report.capabilities).toHaveLength(4)
    expect(report.capabilities.map((capability) => capability.name)).toEqual([
      'webcodecs',
      'camera',
      'opfs',
      'speech',
    ])
    for (const capability of report.capabilities) {
      expect(capability.ok).toBe(true)
      expect(capability.label).toBeTruthy()
    }
  })

  it.each(['webcodecs', 'camera', 'opfs', 'speech'] as const)(
    'fails overall when the %s probe fails, keeping the others ok',
    async (failing) => {
      const report = await checkCapabilities({ ...allPass, [failing]: fail(`${failing} broken`) })
      expect(report.ok).toBe(false)
      expect(findCapability(report.capabilities, failing)).toMatchObject({
        ok: false,
        detail: `${failing} broken`,
      })
      for (const capability of report.capabilities) {
        if (capability.name !== failing) expect(capability.ok).toBe(true)
      }
    },
  )

  it('turns a throwing probe into a failed capability instead of an exception', async () => {
    const report = await checkCapabilities({
      ...allPass,
      webcodecs: async () => {
        throw new Error('boom')
      },
    })
    expect(report.ok).toBe(false)
    expect(findCapability(report.capabilities, 'webcodecs')).toMatchObject({
      ok: false,
      detail: 'probe threw: boom',
    })
  })

  it('fails a capability whose probe never settles, using the timeout', async () => {
    const never = (): Promise<ProbeOutcome> => new Promise<ProbeOutcome>(() => {})
    const report = await checkCapabilities({ ...allPass, webcodecs: never }, 10)
    expect(report.ok).toBe(false)
    expect(findCapability(report.capabilities, 'webcodecs')).toMatchObject({
      ok: false,
      detail: 'probe timed out',
    })
  })
})

describe('probeWebCodecs', () => {
  it('passes when MediaStreamTrackProcessor is a constructor function', async () => {
    expect(await probeWebCodecs(class {})).toEqual({ ok: true })
  })

  it('fails when MediaStreamTrackProcessor is absent', async () => {
    expect(await probeWebCodecs(undefined)).toEqual({
      ok: false,
      detail: 'MediaStreamTrackProcessor is not available',
    })
  })

  it('fails when the global exists but is not a function', async () => {
    expect(await probeWebCodecs({})).toMatchObject({ ok: false })
  })
})

describe('probeCamera', () => {
  it('passes when getUserMedia is a function', async () => {
    expect(await probeCamera({ getUserMedia: () => {} })).toEqual({ ok: true })
  })

  it('fails when mediaDevices is missing', async () => {
    expect(await probeCamera(undefined)).toMatchObject({ ok: false })
  })

  it('fails when getUserMedia is missing', async () => {
    expect(await probeCamera({})).toMatchObject({ ok: false })
  })
})

describe('probeSpeech', () => {
  it('passes when speechSynthesis is present', async () => {
    expect(await probeSpeech({ speak: () => {} })).toEqual({ ok: true })
  })

  it('fails when speechSynthesis is missing', async () => {
    expect(await probeSpeech(undefined)).toMatchObject({ ok: false })
  })
})
