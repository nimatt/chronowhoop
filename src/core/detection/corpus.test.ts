/// <reference types="node" />

// The tier-aware corpus CI gate (plan 04 item 5): discovers every committed
// clip under fixtures/clips, pairs it with its annotation sidecar, and runs
// the corpus harness with default tunables and detector config. Two ways to
// fail, per the ratchet: a must-pass clip that misses a crossing or emits a
// false positive, and a known-limitation clip that unexpectedly passes in
// full (promote its sidecar to must-pass instead of leaving the progress
// unpinned).

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseAnnotation } from './annotation'
import { runCorpus, type CorpusEntry } from './corpus-harness'

function repoPath(relative: string): string {
  return fileURLToPath(new URL(`../../../${relative}`, import.meta.url))
}

const CLIP_SUFFIX = '.cwclip'
const clipNames = readdirSync(repoPath('fixtures/clips'))
  .filter((file) => file.endsWith(CLIP_SUFFIX))
  .map((file) => file.slice(0, -CLIP_SUFFIX.length))
  .sort()

function annotationPath(name: string): string {
  return repoPath(`fixtures/annotations/${name}.json`)
}

function loadEntry(name: string): CorpusEntry {
  return {
    name,
    clipBytes: new Uint8Array(readFileSync(repoPath(`fixtures/clips/${name}${CLIP_SUFFIX}`))),
    annotation: parseAnnotation(readFileSync(annotationPath(name), 'utf8')),
  }
}

describe('tiered corpus regression (fixtures/)', () => {
  it('every committed clip has an annotation sidecar', () => {
    for (const name of clipNames) {
      expect(
        existsSync(annotationPath(name)),
        `fixtures/clips/${name}${CLIP_SUFFIX} has no sidecar in fixtures/annotations/ — ` +
          'an untiered clip escapes the corpus gate entirely',
      ).toBe(true)
    }
  })

  const results = runCorpus(clipNames.filter((name) => existsSync(annotationPath(name))).map(loadEntry))
  const mustPass = results.filter((result) => result.tier === 'must-pass')
  const knownLimitation = results.filter((result) => result.tier === 'known-limitation')

  it('the must-pass tier is non-empty (the gate genuinely runs)', () => {
    expect(mustPass.length).toBeGreaterThan(0)
  })

  it('every must-pass clip is fully detected with zero false positives', () => {
    for (const result of mustPass) {
      const annotated = result.matched + result.missed
      expect(
        result.pass,
        `must-pass clip "${result.name}" regressed: matched ${result.matched}/${annotated} ` +
          `annotated crossing(s), ${result.falsePositives} false positive(s)`,
      ).toBe(true)
    }
  })

  it('no known-limitation clip passes unexpectedly (ratchet)', () => {
    for (const result of knownLimitation) {
      expect(
        result.unexpectedPass,
        `known-limitation clip "${result.name}" now fully passes — promote its sidecar tier ` +
          'to must-pass so the progress is ratcheted in',
      ).toBe(false)
    }
  })
})
