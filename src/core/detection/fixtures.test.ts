/// <reference types="node" />

// Fixture freshness: the committed corpus files under fixtures/ are PINNED by
// this test — rebuilding them from their synthetic definition here must be
// byte-identical to what is in git. This test IS the generator (the repo
// killed one-shot scripts in Phase 1): run
//
//   UPDATE_FIXTURES=1 bun run test
//
// to (re)write the committed files, then commit them together with whatever
// change made them move (a tunables/reducer change legitimately moves the
// energy JSON — clips and annotations only move if the clip definition here
// changes).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { decodeClip, encodeClip } from './clip-format'
import { parseAnnotation, serializeAnnotation, type ClipAnnotation } from './annotation'
import { encodeEnergyJson, parseEnergyJson } from './energy-json'
import { regenerateEnergyJson } from './regenerate'
import { SyntheticSource } from './synthetic-source'
import type { LumaFrame } from './types'

const UPDATE = process.env.UPDATE_FIXTURES === '1'

const CLIP_PATH = repoPath('fixtures/clips/synthetic-crossing-64x36.cwclip')
const ANNOTATION_PATH = repoPath('fixtures/annotations/synthetic-crossing-64x36.json')
const ENERGY_PATH = repoPath('fixtures/energies/synthetic-crossing-64x36.energy.json')

function repoPath(relative: string): string {
  return fileURLToPath(new URL(`../../../${relative}`, import.meta.url))
}

const FIXTURE_CONDITIONS = {
  scene: 'synthetic',
  description:
    'one blob fly-through left-to-right over a quiet noisy background, ' +
    'with timestamp jitter and one dropped frame (dt-scaling coverage)',
  generator: 'src/core/detection/fixtures.test.ts',
}

// The committed fixture's full definition. 64×36 keeps 30 delivered frames
// ≈ 68 KB — inside the well-under-100-KB budget for this seed fixture. The
// noise is a stateless hash (no RNG state) so any frame is reproducible in
// isolation, and its ±2 amplitude stays far below the diff threshold:
// background strips read exactly 0.
//
// The timeline is deliberately NON-uniform — per-frame timestamp jitter plus
// a dropped frame (20) — so the committed energies depend on dt-scaled EMA
// math: the gap's doubled dt makes the trail behind the blob at frame 23
// (columns 54–56, adapted with alphaEff ≈ 0.096 then ≈ 0.052) sit just ABOVE
// the diff threshold, while a constant-per-frame alpha of 0.05 leaves it
// below. A uniform-60 fps fixture was blind to exactly that regression
// (dt-scaled and constant alpha coincide at 16.67 ms).
function fixtureSource(): SyntheticSource {
  return new SyntheticSource({
    width: 64,
    height: 36,
    frameCount: 31,
    backgroundLevel: 32,
    frameJitterMs: (f) => (f % 3) * 0.7,
    isFrameDropped: (f) => f === 20,
    noise: (x, y, f) => ((x * 31 + y * 17 + f * 13) % 5) - 2,
    blob: { widthPx: 6, intensity: 240, speedPxPerFrame: 3, direction: 1, startFrame: 2 },
  })
}

function buildClipBytes(): Uint8Array {
  const source = fixtureSource()
  const frames: LumaFrame[] = []
  source.start((frame) => frames.push(frame))
  source.pumpAll()
  return encodeClip(frames, FIXTURE_CONDITIONS)
}

function buildAnnotation(): ClipAnnotation {
  const groundTruth = fixtureSource().groundTruth
  if (!groundTruth) throw new Error('fixture blob never crosses — definition is broken')
  return {
    formatVersion: 1,
    tier: 'must-pass',
    crossings: [{ frameIndex: groundTruth.crossingFrameIndex, direction: 'ltr' }],
    conditions: FIXTURE_CONDITIONS,
    notes:
      'Synthetic seed fixture. Ground truth is mathematical (SyntheticSource.groundTruth), ' +
      'not hand-annotated: first frame whose blob center reaches the horizontal midpoint.',
  }
}

function writeFixture(path: string, content: Uint8Array | string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function readCommitted(path: string): Buffer {
  if (!existsSync(path)) {
    throw new Error(`missing committed fixture ${path} — write it with: UPDATE_FIXTURES=1 bun run test`)
  }
  return readFileSync(path)
}

function expectSameBytes(committed: Buffer, built: Uint8Array, what: string): void {
  const stale = `${what} is stale — regenerate with: UPDATE_FIXTURES=1 bun run test`
  expect(committed.byteLength, stale).toBe(built.byteLength)
  expect(committed.compare(built), stale).toBe(0)
}

describe('committed fixtures (fixtures/)', () => {
  it('clip matches byte-identical regeneration from its synthetic definition', () => {
    const built = buildClipBytes()
    if (UPDATE) writeFixture(CLIP_PATH, built)
    expectSameBytes(readCommitted(CLIP_PATH), built, 'fixtures/clips/synthetic-crossing-64x36.cwclip')
  })

  it('annotation matches the mathematical ground truth', () => {
    const built = serializeAnnotation(buildAnnotation())
    if (UPDATE) writeFixture(ANNOTATION_PATH, built)
    const committed = readCommitted(ANNOTATION_PATH).toString('utf8')
    expect(committed, 'annotation sidecar is stale — UPDATE_FIXTURES=1 bun run test').toBe(built)
    expect(parseAnnotation(committed).crossings).toEqual([{ frameIndex: 14, direction: 'ltr' }])
  })

  it('energy JSON matches byte-identical regeneration from the committed clip', () => {
    // The document embeds tunables.emaTimeConstantMs, whose default is the
    // Math.log-derived EMA_TIME_CONSTANT_MS (types.ts) — a computed double
    // whose last ULP (and its JSON number formatting) is engine-family
    // sensitive. Regeneration and byte comparison must run in the same
    // runtime family (node/V8, as CI does); re-check before comparing bytes
    // produced by another engine.
    const clipBytes = UPDATE ? buildClipBytes() : readCommitted(CLIP_PATH)
    const built = encodeEnergyJson(regenerateEnergyJson(clipBytes))
    if (UPDATE) writeFixture(ENERGY_PATH, built)
    const committed = readCommitted(ENERGY_PATH).toString('utf8')
    expect(committed, 'energy JSON is stale — UPDATE_FIXTURES=1 bun run test').toBe(built)

    const parsed = parseEnergyJson(committed)
    expect(parsed.frames).toHaveLength(30)
    expect(parsed.frames[0].energies.every((e) => e === 0)).toBe(true)
    const hotAtCrossing = parsed.frames[14].energies.some((e) => e > 0)
    expect(hotAtCrossing).toBe(true)
  })

  it('the clip timeline is non-uniform (guards the dt-scaling coverage)', () => {
    // A uniform-dt fixture cannot distinguish dt-scaled EMA adaptation from a
    // constant per-frame alpha; this pins the jitter and the dropped-frame
    // gap that make the committed energies sensitive to that regression.
    const { header } = decodeClip(new Uint8Array(readCommitted(CLIP_PATH)))
    const dts = header.captureTimesMs.slice(1).map((t, i) => t - header.captureTimesMs[i])
    expect(new Set(dts.map((dt) => dt.toFixed(3))).size).toBeGreaterThan(2)
    expect(Math.max(...dts)).toBeGreaterThan(1.8 * Math.min(...dts))
  })

  it('total committed fixture bytes stay well under 100 KB', () => {
    const total =
      readCommitted(CLIP_PATH).byteLength +
      readCommitted(ANNOTATION_PATH).byteLength +
      readCommitted(ENERGY_PATH).byteLength
    expect(total).toBeLessThan(90 * 1024)
  })
})
