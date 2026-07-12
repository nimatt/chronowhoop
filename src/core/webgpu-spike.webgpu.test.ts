import { describe, expect, it } from 'vitest'

// Hello-world WebGPU spike (Phase 1, item 9): prove the whole
// adapter → device → compute dispatch → buffer readback path runs in TRUE
// headless Chromium on the software (SwiftShader) backend, before any WGSL
// product code exists. Not product code — this file is a CI capability probe.

const doubleShader = /* wgsl */ `
  @group(0) @binding(0) var<storage, read_write> data: array<f32>;

  @compute @workgroup_size(64)
  fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let i = gid.x;
    if (i < arrayLength(&data)) {
      data[i] = data[i] * 2.0;
    }
  }
`

describe('WebGPU compute spike (SwiftShader-capable)', () => {
  it('doubles an array via a compute shader and reads it back', async () => {
    expect(navigator.gpu, 'navigator.gpu should exist').toBeTruthy()

    const adapter = await navigator.gpu.requestAdapter()
    expect(adapter, 'requestAdapter() should return an adapter').toBeTruthy()

    const device = await adapter!.requestDevice()
    expect(device, 'requestDevice() should return a device').toBeTruthy()

    const input = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8])
    const byteLength = input.byteLength

    const storageBuffer = device.createBuffer({
      size: byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    })
    device.queue.writeBuffer(storageBuffer, 0, input)

    const readbackBuffer = device.createBuffer({
      size: byteLength,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    })

    const module = device.createShaderModule({ code: doubleShader })
    const pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    })

    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: storageBuffer } }],
    })

    const encoder = device.createCommandEncoder()
    const pass = encoder.beginComputePass()
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, bindGroup)
    pass.dispatchWorkgroups(Math.ceil(input.length / 64))
    pass.end()
    encoder.copyBufferToBuffer(storageBuffer, 0, readbackBuffer, 0, byteLength)
    device.queue.submit([encoder.finish()])

    await readbackBuffer.mapAsync(GPUMapMode.READ)
    const result = new Float32Array(readbackBuffer.getMappedRange().slice(0))
    readbackBuffer.unmap()

    expect(Array.from(result)).toEqual([2, 4, 6, 8, 10, 12, 14, 16])

    device.destroy()
  })
})
