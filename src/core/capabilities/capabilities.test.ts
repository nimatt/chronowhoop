import { describe, expect, it } from 'vitest'
import {
  checkCapabilities,
  probeCamera,
  probeSpeech,
  probeWebGpu,
  type CapabilityProbes,
  type GpuLike,
  type ProbeOutcome,
} from './capabilities'

const pass = async (): Promise<ProbeOutcome> => ({ ok: true })
const fail =
  (detail: string) =>
  async (): Promise<ProbeOutcome> => ({ ok: false, detail })

const allPass: CapabilityProbes = { webgpu: pass, camera: pass, opfs: pass, speech: pass }

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
      'webgpu',
      'camera',
      'opfs',
      'speech',
    ])
    for (const capability of report.capabilities) {
      expect(capability.ok).toBe(true)
      expect(capability.label).toBeTruthy()
    }
  })

  it.each(['webgpu', 'camera', 'opfs', 'speech'] as const)(
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
      webgpu: async () => {
        throw new Error('boom')
      },
    })
    expect(report.ok).toBe(false)
    expect(findCapability(report.capabilities, 'webgpu')).toMatchObject({
      ok: false,
      detail: 'probe threw: boom',
    })
  })

  it('fails a capability whose probe never settles, using the timeout', async () => {
    const never = (): Promise<ProbeOutcome> => new Promise<ProbeOutcome>(() => {})
    const report = await checkCapabilities({ ...allPass, webgpu: never }, 10)
    expect(report.ok).toBe(false)
    expect(findCapability(report.capabilities, 'webgpu')).toMatchObject({
      ok: false,
      detail: 'probe timed out',
    })
  })

  it('marks every capability as required so the gate needs all four', async () => {
    const report = await checkCapabilities(allPass)
    for (const capability of report.capabilities) {
      expect(capability.required).toBe(true)
    }
  })
})

describe('probeWebGpu', () => {
  const workingGpu: GpuLike = {
    requestAdapter: async () => ({
      requestDevice: async () => ({ destroy: () => {} }),
    }),
  }

  it('passes when adapter and device are both available', async () => {
    expect(await probeWebGpu(workingGpu)).toEqual({ ok: true })
  })

  it('destroys the probe device', async () => {
    let destroyed = false
    const gpu: GpuLike = {
      requestAdapter: async () => ({
        requestDevice: async () => ({
          destroy: () => {
            destroyed = true
          },
        }),
      }),
    }
    await probeWebGpu(gpu)
    expect(destroyed).toBe(true)
  })

  it('fails when navigator.gpu is missing', async () => {
    expect(await probeWebGpu(undefined)).toEqual({
      ok: false,
      detail: 'navigator.gpu is not available',
    })
  })

  it('fails when no adapter is returned', async () => {
    const gpu: GpuLike = { requestAdapter: async () => null }
    expect(await probeWebGpu(gpu)).toEqual({
      ok: false,
      detail: 'requestAdapter() returned no adapter',
    })
  })

  it('propagates a requestDevice rejection to the caller (checkCapabilities catches it)', async () => {
    const gpu: GpuLike = {
      requestAdapter: async () => ({
        requestDevice: async () => {
          throw new Error('blocklisted GPU')
        },
      }),
    }
    await expect(probeWebGpu(gpu)).rejects.toThrow('blocklisted GPU')
    const report = await checkCapabilities({ ...allPass, webgpu: () => probeWebGpu(gpu) })
    expect(findCapability(report.capabilities, 'webgpu')).toMatchObject({
      ok: false,
      detail: 'probe threw: blocklisted GPU',
    })
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
