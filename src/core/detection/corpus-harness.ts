// Tier-aware corpus harness (plan 04 item 5): replays annotated clips through
// the full offline detection path — decodeClip → ClipSource →
// DetectionPipeline → CrossingDetector (default tunables/config unless the
// caller overrides) — and scores the emitted crossings against the sidecar's
// ground truth. Pure and synchronous, runs in plain node; corpus.test.ts is
// the CI gate.
//
// The ratchet (detection.md "Fixture formats", testing.md Video-E2E):
// must-pass clips fail the run on any miss or false positive;
// known-limitation clips never fail it, but a clip that FULLY passes is
// flagged `unexpectedPass` so CI forces its promotion to must-pass — progress
// gets ratcheted in explicitly, never silently.

import type { ClipAnnotation, ClipTier } from './annotation'
import type { CrossingEvent } from './crossing-events'
import type { DetectionTunables } from './types'
import { DEFAULT_DETECTION_TUNABLES } from './types'
import { decodeClip } from './clip-format'
import { ClipSource } from './clip-source'
import { DetectionPipeline } from './pipeline'
import {
  CrossingDetector,
  attachDetectorToPipeline,
  type CrossingDetectorConfig,
} from './crossing-detector'

export interface CorpusEntry {
  name: string
  clipBytes: Uint8Array
  annotation: ClipAnnotation
}

export interface CorpusRunConfig {
  tunables?: Partial<DetectionTunables>
  detector?: Partial<CrossingDetectorConfig>
}

export interface CorpusClipResult {
  name: string
  tier: ClipTier
  // Annotated crossings the detector found: same direction AND emitted
  // timestamp within one frame interval (the clip's median capture-timestamp
  // delta) of the annotated frame's capture time.
  matched: number
  // Annotated crossings with no matching emitted event.
  missed: number
  // Emitted events matching no annotated crossing.
  falsePositives: number
  // must-pass: every annotated crossing matched and zero false positives.
  // known-limitation: always true — these clips never fail the run.
  pass: boolean
  // known-limitation only: the clip fully passed anyway. CI fails on this so
  // the sidecar gets promoted to must-pass (the ratchet).
  unexpectedPass: boolean
}

export function runCorpus(
  entries: readonly CorpusEntry[],
  config: CorpusRunConfig = {},
): CorpusClipResult[] {
  return entries.map((entry) => runClip(entry, config))
}

function runClip(entry: CorpusEntry, config: CorpusRunConfig): CorpusClipResult {
  const { header, frames } = decodeClip(entry.clipBytes)
  for (const crossing of entry.annotation.crossings) {
    if (crossing.frameIndex >= header.frameCount) {
      throw new Error(
        `corpus clip "${entry.name}": annotated frameIndex ${crossing.frameIndex} ` +
          `is out of range for a ${header.frameCount}-frame clip`,
      )
    }
  }

  const source = new ClipSource(frames)
  const pipeline = new DetectionPipeline(source, config.tunables ?? {})
  // Precedence (detection.md, Tunables): the detector's triggerLevel follows
  // the effective tunables' triggerLevel unless config.detector overrides it
  // explicitly — a tuning-loop caller adjusting tunables.triggerLevel must
  // not silently run the detector at the default.
  const detector = new CrossingDetector({
    triggerLevel: config.tunables?.triggerLevel ?? DEFAULT_DETECTION_TUNABLES.triggerLevel,
    ...config.detector,
  })
  const emitted: CrossingEvent[] = []
  attachDetectorToPipeline(pipeline, detector, (event) => emitted.push(event))
  source.pumpAll()
  pipeline.stop()

  const toleranceMs = medianFrameIntervalMs(header.captureTimesMs)
  const claimed = new Set<number>()
  let matched = 0
  for (const crossing of entry.annotation.crossings) {
    const annotatedTimeMs = header.captureTimesMs[crossing.frameIndex]
    let bestIndex = -1
    let bestDeltaMs = Infinity
    for (let i = 0; i < emitted.length; i++) {
      if (claimed.has(i) || emitted[i].direction !== crossing.direction) continue
      const deltaMs = Math.abs(emitted[i].timestampMs - annotatedTimeMs)
      if (deltaMs <= toleranceMs && deltaMs < bestDeltaMs) {
        bestIndex = i
        bestDeltaMs = deltaMs
      }
    }
    if (bestIndex >= 0) {
      claimed.add(bestIndex)
      matched++
    }
  }

  const missed = entry.annotation.crossings.length - matched
  const falsePositives = emitted.length - matched
  const clean = missed === 0 && falsePositives === 0
  const mustPass = entry.annotation.tier === 'must-pass'
  return {
    name: entry.name,
    tier: entry.annotation.tier,
    matched,
    missed,
    falsePositives,
    pass: mustPass ? clean : true,
    unexpectedPass: !mustPass && clean,
  }
}

function medianFrameIntervalMs(captureTimesMs: readonly number[]): number {
  if (captureTimesMs.length < 2) return 0
  const deltas = captureTimesMs
    .slice(1)
    .map((t, i) => t - captureTimesMs[i])
    .sort((a, b) => a - b)
  const mid = Math.floor(deltas.length / 2)
  return deltas.length % 2 === 1 ? deltas[mid] : (deltas[mid - 1] + deltas[mid]) / 2
}
