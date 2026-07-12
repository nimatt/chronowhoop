// Texture-import spike (device-spike work item 4): which import paths work
// for which source kinds, and the rough JS-visible per-frame cost of each.
// "Works" is established end-to-end: each iteration binds the imported
// texture into a minimal luminance dispatch and submits it inside a
// validation error scope, because an import call can succeed while the path
// fails at bind/dispatch/submit (the SwiftShader instance-drop is exactly
// this class of failure).

import type { ClockLike } from '../frame-loop/frame-loop'
import { defaultClock } from '../frame-loop/frame-loop'
import { CopyTarget, type SpikeFrame } from './frame-import'
import { LuminancePass, type Roi } from './luminance-pass'
import { medianOf, quantileOf } from './readback-stats'

export type ImportPathName = 'importExternalTexture' | 'copyExternalImageToTexture'
export type ImportSourceKind = 'video-element' | 'video-frame'

export interface ImportPathResult {
  path: ImportPathName
  source: ImportSourceKind
  attempted: boolean
  // True when every iteration's import call PLUS a minimal compute dispatch
  // sampling the imported texture submitted without throwing or raising a
  // validation error — not merely "the import call succeeded".
  ok: boolean
  error?: string
  framesMeasured?: number
  medianImportCostUs?: number
  p95ImportCostUs?: number
}

export interface TextureImportProbeReport {
  timingNote: string
  results: ImportPathResult[]
}

// Honesty note carried in the report so the /diag panel shows it next to the
// numbers — including the same-frame cache caveat, so a transcribed
// importExternalTexture median cannot silently pass for a per-new-frame cost.
export const IMPORT_TIMING_NOTE =
  'Costs are the JS-visible duration of the import/copy call only; GPU-side work ' +
  '(decode, copy, color conversion) is queued asynchronously and not captured here. ' +
  'OK means the imported texture also bound and submitted through a minimal compute ' +
  'dispatch without validation errors. Live-source iterations are separated only by ' +
  'macrotask yields, so most re-import the SAME camera frame: importExternalTexture ' +
  'medians can be a same-frame cache hit, not the per-new-frame import cost — the ' +
  'readback benchmark measures the real per-new-frame path.'

export interface TextureImportProbeSources {
  // Live-stream video element; omitted → the video-element rows are skipped.
  videoElement?: HTMLVideoElement
  // Factory for constructed VideoFrames (Phase 3 wants this path for CI and
  // replay); called once per measured frame, the probe closes each frame.
  createVideoFrame?: () => VideoFrame
}

export interface TextureImportProbeOptions {
  framesPerPath?: number
  clock?: ClockLike
}

export const DEFAULT_PROBE_FRAMES_PER_PATH = 30

interface FrameSupply {
  next(): SpikeFrame
  release?(frame: SpikeFrame): void
}

// Tiny ROI (the shader clamps to the texture) so the per-iteration viability
// dispatch stays cheap and off the timed import call.
const PROBE_DISPATCH_ROI: Roi = { x: 0, y: 0, width: 8, height: 8 }

async function measureImportPath(
  device: GPUDevice,
  path: ImportPathName,
  source: ImportSourceKind,
  supply: FrameSupply,
  frames: number,
  clock: ClockLike,
): Promise<ImportPathResult> {
  const copyTarget = new CopyTarget(device)
  const pass = new LuminancePass(device, PROBE_DISPATCH_ROI)
  const costsUs: number[] = []
  try {
    // Iteration 0 is an untimed warm-up: identical code path, cost not
    // recorded, so one-time setup inside the timed call (the copy path
    // creates its destination texture on first use) cannot inflate a small
    // sample's p95/max. Validation still applies — a path that fails on the
    // warm-up is a failed path.
    for (let i = 0; i <= frames; i++) {
      const isWarmup = i === 0
      const frame = supply.next()
      device.pushErrorScope('validation')
      try {
        // Only the import/copy call is timed; the viability dispatch below is
        // encoded and submitted outside the timed region. Frames are released
        // only after submit — closing a VideoFrame first would invalidate its
        // external texture.
        const encoder = device.createCommandEncoder()
        const start = clock.now()
        if (path === 'importExternalTexture') {
          const texture = device.importExternalTexture({
            source: frame as HTMLVideoElement | VideoFrame,
          })
          if (!isWarmup) costsUs.push((clock.now() - start) * 1000)
          pass.encodeExternal(encoder, texture)
        } else {
          const texture = copyTarget.copyFrame(frame)
          if (!isWarmup) costsUs.push((clock.now() - start) * 1000)
          pass.encodeTexture2d(encoder, texture)
        }
        device.queue.submit([encoder.finish()])
      } finally {
        supply.release?.(frame)
      }
      const validationError = await device.popErrorScope()
      if (validationError) {
        return { path, source, attempted: true, ok: false, error: validationError.message }
      }
      // Yield a macrotask so per-frame import isn't measured in an artificial
      // same-task burst (external textures also expire at task boundaries).
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    return {
      path,
      source,
      attempted: true,
      ok: true,
      framesMeasured: costsUs.length,
      medianImportCostUs: medianOf(costsUs),
      p95ImportCostUs: quantileOf(costsUs, 0.95),
    }
  } catch (error) {
    // A pushed error scope may be left unpopped when the call throws; that
    // leaks a scope entry on this device, which is harmless for a probe.
    return {
      path,
      source,
      attempted: true,
      ok: false,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    }
  } finally {
    pass.destroy()
    copyTarget.destroy()
  }
}

function skipped(path: ImportPathName, source: ImportSourceKind, reason: string): ImportPathResult {
  return { path, source, attempted: false, ok: false, error: reason }
}

export async function probeTextureImport(
  device: GPUDevice,
  sources: TextureImportProbeSources,
  options: TextureImportProbeOptions = {},
): Promise<TextureImportProbeReport> {
  const frames = options.framesPerPath ?? DEFAULT_PROBE_FRAMES_PER_PATH
  const clock = options.clock ?? defaultClock()
  const paths: ImportPathName[] = ['importExternalTexture', 'copyExternalImageToTexture']
  const results: ImportPathResult[] = []

  for (const path of paths) {
    if (sources.videoElement === undefined) {
      results.push(skipped(path, 'video-element', 'no video element provided'))
    } else {
      const video = sources.videoElement
      results.push(
        await measureImportPath(device, path, 'video-element', { next: () => video }, frames, clock),
      )
    }
  }

  for (const path of paths) {
    if (sources.createVideoFrame === undefined) {
      results.push(skipped(path, 'video-frame', 'no VideoFrame factory provided'))
    } else {
      const supply: FrameSupply = {
        next: sources.createVideoFrame,
        release: (frame) => (frame as VideoFrame).close(),
      }
      results.push(await measureImportPath(device, path, 'video-frame', supply, frames, clock))
    }
  }

  return { timingNote: IMPORT_TIMING_NOTE, results }
}
