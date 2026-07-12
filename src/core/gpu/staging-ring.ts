// 3-deep staging-buffer ring for per-frame GPU→CPU readback (device-spike
// work item 5). The ring never blocks the frame loop: when every buffer is
// still mapped/pending, acquire() fails fast and the caller counts a readback
// overrun instead of stalling.

// Structural seam over GPUBuffer so the scheduling/overrun logic unit-tests in
// node with fake buffers. GPUBuffer satisfies this shape.
export interface StagingBufferLike {
  mapAsync(mode: number): Promise<unknown>
  getMappedRange(): ArrayBuffer
  unmap(): void
  destroy?(): void
}

export interface StagingSlot<B extends StagingBufferLike> {
  readonly index: number
  readonly buffer: B
}

export const STAGING_RING_DEPTH = 3

// GPUMapMode.READ — inlined so node unit tests with fake buffers don't need
// the WebGPU global.
const MAP_MODE_READ = 1

export class StagingRing<B extends StagingBufferLike> {
  private readonly inFlight = new Set<number>()
  private overrunCount = 0

  constructor(private readonly buffers: readonly B[]) {
    if (buffers.length === 0) throw new Error('StagingRing needs at least one buffer')
  }

  get pending(): number {
    return this.inFlight.size
  }

  get overruns(): number {
    return this.overrunCount
  }

  // Returns a free slot and marks it in-flight, or counts an overrun and
  // returns undefined when all slots are pending.
  acquire(): StagingSlot<B> | undefined {
    for (let index = 0; index < this.buffers.length; index++) {
      if (!this.inFlight.has(index)) {
        this.inFlight.add(index)
        return { index, buffer: this.buffers[index] }
      }
    }
    this.overrunCount++
    return undefined
  }

  // Maps the slot's buffer, reads the single f32 result, unmaps, and frees the
  // slot. The slot is freed even when mapping fails, so a rejected mapAsync
  // (e.g. device loss) cannot permanently shrink the ring.
  async readValue(slot: StagingSlot<B>): Promise<number> {
    try {
      await slot.buffer.mapAsync(MAP_MODE_READ)
      const value = new Float32Array(slot.buffer.getMappedRange())[0]
      slot.buffer.unmap()
      return value
    } finally {
      this.inFlight.delete(slot.index)
    }
  }

  // Frees a slot without reading, for when the work that would have filled it
  // was never submitted.
  release(slot: StagingSlot<B>): void {
    this.inFlight.delete(slot.index)
  }

  destroy(): void {
    for (const buffer of this.buffers) buffer.destroy?.()
  }
}

export const READBACK_RESULT_BYTES = 4

export function createStagingRing(device: GPUDevice): StagingRing<GPUBuffer> {
  const buffers = Array.from({ length: STAGING_RING_DEPTH }, (_, index) =>
    device.createBuffer({
      label: `readback-staging-${index}`,
      size: READBACK_RESULT_BYTES,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    }),
  )
  return new StagingRing(buffers)
}
