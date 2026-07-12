// Minimal WGSL pass for the device spike (work item 5): mean luminance of a
// fixed ROI, reduced to a single f32. Deliberately NOT the real detection
// pipeline — no EMA, no strips, no threshold. Two shader variants cover the
// two texture-import paths: texture_external (importExternalTexture) and
// texture_2d<f32> (copyExternalImageToTexture).

export interface Roi {
  x: number
  y: number
  width: number
  height: number
}

// The shader clamps the ROI to the texture, so this sentinel means "whole
// frame" for any frame up to 65535 px per side.
export const FULL_FRAME_ROI: Roi = { x: 0, y: 0, width: 0xffff, height: 0xffff }

// A size×size ROI centered in a width×height frame. Unknown or too-small
// dimensions clamp the origin to (0, 0); the shader clamps the ROI to the
// texture regardless, so the ROI never reads outside the frame.
export function centeredRoi(width: number, height: number, size: number): Roi {
  return {
    x: Math.max(0, Math.floor((width - size) / 2)),
    y: Math.max(0, Math.floor((height - size) / 2)),
    width: size,
    height: size,
  }
}

const WORKGROUP_SIZE = 256

// Single-workgroup two-stage reduction: each invocation strides over the ROI
// accumulating a partial luminance sum, then invocation 0 folds the partials
// and writes mean = sum / count. Correctness over throughput — one workgroup
// is plenty for a spike ROI.
function luminanceShader(textureDecl: string, loadExpr: string): string {
  return /* wgsl */ `
    struct Roi { x: u32, y: u32, width: u32, height: u32 }

    @group(0) @binding(0) var src: ${textureDecl};
    @group(0) @binding(1) var<uniform> roi: Roi;
    @group(0) @binding(2) var<storage, read_write> result: array<f32, 1>;

    var<workgroup> partialSums: array<f32, ${WORKGROUP_SIZE}>;
    var<workgroup> partialCounts: array<u32, ${WORKGROUP_SIZE}>;

    @compute @workgroup_size(${WORKGROUP_SIZE})
    fn main(@builtin(local_invocation_index) lid: u32) {
      let dims = textureDimensions(src);
      let x0 = min(roi.x, dims.x);
      let y0 = min(roi.y, dims.y);
      let x1 = min(roi.x + roi.width, dims.x);
      let y1 = min(roi.y + roi.height, dims.y);
      let w = x1 - x0;
      let total = w * (y1 - y0);

      var sum = 0.0;
      var count = 0u;
      var i = lid;
      for (; i < total; i += ${WORKGROUP_SIZE}u) {
        let px = vec2<u32>(x0 + (i % w), y0 + (i / w));
        let rgb = ${loadExpr};
        sum += dot(rgb, vec3f(0.2126, 0.7152, 0.0722));
        count += 1u;
      }
      partialSums[lid] = sum;
      partialCounts[lid] = count;
      workgroupBarrier();

      if (lid == 0u) {
        var totalSum = 0.0;
        var totalCount = 0u;
        for (var j = 0u; j < ${WORKGROUP_SIZE}u; j++) {
          totalSum += partialSums[j];
          totalCount += partialCounts[j];
        }
        result[0] = select(0.0, totalSum / f32(totalCount), totalCount > 0u);
      }
    }
  `
}

const externalShader = luminanceShader('texture_external', 'textureLoad(src, px).rgb')
const texture2dShader = luminanceShader('texture_2d<f32>', 'textureLoad(src, px, 0u).rgb')

export class LuminancePass {
  // Single-f32 result the caller copies into a staging buffer per frame.
  readonly resultBuffer: GPUBuffer
  private readonly roiBuffer: GPUBuffer
  private externalPipeline: GPUComputePipeline | undefined
  private texture2dPipeline: GPUComputePipeline | undefined

  constructor(
    private readonly device: GPUDevice,
    roi: Roi = FULL_FRAME_ROI,
  ) {
    this.resultBuffer = device.createBuffer({
      label: 'luminance-result',
      size: 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    })
    this.roiBuffer = device.createBuffer({
      label: 'luminance-roi',
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    device.queue.writeBuffer(
      this.roiBuffer,
      0,
      new Uint32Array([roi.x, roi.y, roi.width, roi.height]),
    )
  }

  encodeExternal(encoder: GPUCommandEncoder, texture: GPUExternalTexture): void {
    this.externalPipeline ??= this.createPipeline(externalShader, 'luminance-external')
    this.encode(encoder, this.externalPipeline, texture)
  }

  encodeTexture2d(encoder: GPUCommandEncoder, texture: GPUTexture): void {
    this.texture2dPipeline ??= this.createPipeline(texture2dShader, 'luminance-texture2d')
    this.encode(encoder, this.texture2dPipeline, texture.createView())
  }

  destroy(): void {
    this.resultBuffer.destroy()
    this.roiBuffer.destroy()
  }

  private createPipeline(code: string, label: string): GPUComputePipeline {
    const module = this.device.createShaderModule({ label, code })
    return this.device.createComputePipeline({
      label,
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    })
  }

  // External textures expire per-frame, so the bind group is rebuilt on every
  // encode for both variants — simplest correct thing for measurement code.
  private encode(
    encoder: GPUCommandEncoder,
    pipeline: GPUComputePipeline,
    source: GPUExternalTexture | GPUTextureView,
  ): void {
    const bindGroup = this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: source },
        { binding: 1, resource: { buffer: this.roiBuffer } },
        { binding: 2, resource: { buffer: this.resultBuffer } },
      ],
    })
    const pass = encoder.beginComputePass()
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, bindGroup)
    pass.dispatchWorkgroups(1)
    pass.end()
  }
}
