// Resolves the Wave 2 open question (staging notes): the pipeline consumes
// LumaFrames internally and emits only FrameSamples, so recorders that need
// raw frames (ContinuousRecorder) tap the source instead — wrap any LumaSource
// with teeSource() and hand the tee to the DetectionPipeline. The tap sees
// every frame BEFORE the pipeline processes it. Frames are shared by reference
// with the downstream consumer (LumaFrame ownership transfers on emit and
// nobody mutates), so the tap must not modify frame data.

import type { LumaSource } from './frame-source'
import type { LumaFrame } from './types'

export function teeSource(inner: LumaSource, tap: (frame: LumaFrame) => void): LumaSource {
  return {
    start(onFrame: (frame: LumaFrame) => void): void {
      inner.start((frame) => {
        tap(frame)
        onFrame(frame)
      })
    },
    stop(): void {
      inner.stop()
    },
  }
}
