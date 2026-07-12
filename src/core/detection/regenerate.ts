// Fixture-regeneration tool (plan 03 item 8): clip → ClipSource →
// DetectionPipeline → strip-energy JSON. Pure and synchronous — runs in
// plain node at unit-test speed, so energy JSON caches re-derive whenever
// tunables move. The clip stays canonical; this output is the derivative.

import type { DetectionTunables } from './types'
import type { EnergyJson } from './energy-json'
import { ENERGY_JSON_FORMAT_VERSION } from './energy-json'
import { decodeClip } from './clip-format'
import { ClipSource } from './clip-source'
import { DetectionPipeline } from './pipeline'

export function regenerateEnergyJson(
  clipBytes: Uint8Array,
  tunables: Partial<DetectionTunables> = {},
): EnergyJson {
  const { frames } = decodeClip(clipBytes)
  const source = new ClipSource(frames)
  const pipeline = new DetectionPipeline(source, tunables)
  const energyFrames: EnergyJson['frames'] = []
  pipeline.start((sample) => {
    energyFrames.push({
      captureTimeMs: sample.captureTimeMs,
      energies: Array.from(sample.energies),
    })
  })
  source.pumpAll()
  pipeline.stop()
  return {
    formatVersion: ENERGY_JSON_FORMAT_VERSION,
    tunables: pipeline.tunables,
    frames: energyFrames,
  }
}
