// Shared frame-import helpers for the device-spike GPU chain: what a frame
// source can hand us, how big it is, and the persistent destination texture
// for the copyExternalImageToTexture path.

export type SpikeFrame =
  | HTMLVideoElement
  | VideoFrame
  | ImageBitmap
  | HTMLCanvasElement
  | OffscreenCanvas

export interface FrameDimensions {
  width: number
  height: number
}

export function frameDimensions(frame: SpikeFrame): FrameDimensions {
  if ('videoWidth' in frame) return { width: frame.videoWidth, height: frame.videoHeight }
  if ('displayWidth' in frame) return { width: frame.displayWidth, height: frame.displayHeight }
  return { width: frame.width, height: frame.height }
}

// importExternalTexture accepts only these two source kinds.
export function isExternalImportable(frame: SpikeFrame): frame is HTMLVideoElement | VideoFrame {
  return 'videoWidth' in frame || 'displayWidth' in frame
}

// Owns the rgba8unorm destination texture for the copy path, recreating it
// when the incoming frame size changes.
export class CopyTarget {
  private texture: GPUTexture | undefined

  constructor(private readonly device: GPUDevice) {}

  // Queues a copyExternalImageToTexture of the frame and returns the
  // destination texture for binding.
  copyFrame(frame: SpikeFrame): GPUTexture {
    const { width, height } = frameDimensions(frame)
    if (width <= 0 || height <= 0) {
      throw new Error(`frame has no pixels yet (${width}x${height})`)
    }
    if (this.texture === undefined || this.texture.width !== width || this.texture.height !== height) {
      this.texture?.destroy()
      this.texture = this.device.createTexture({
        label: 'copy-import-target',
        size: { width, height },
        format: 'rgba8unorm',
        usage:
          GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
      })
    }
    this.device.queue.copyExternalImageToTexture(
      { source: frame },
      { texture: this.texture },
      { width, height },
    )
    return this.texture
  }

  destroy(): void {
    this.texture?.destroy()
    this.texture = undefined
  }
}
