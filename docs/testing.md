# Test taxonomy

The kinds of test ChronoWhoop uses, why each exists, and where it runs. This is a
reference for choosing the right level for a given change, not an exhaustive list of
suites. Behavior is specified in `docs/specs/`; tests verify against those specs.

Six categories, introduced across the roadmap (`docs/plans/00-roadmap.md`). Concrete
script names live in `package.json` — refer to it rather than to any command written
here.

**Status (Phase 5):** unit tests cover the core services (camera, audio/speech, wake
lock, OPFS probes, the frozen `/diag` spike modules), the full CPU detection pipeline
— sources, reducer goldens and determinism, ring buffer, fixture formats, `ClipSource`
replay, regeneration — and the Phase 5 product core (records, announcer formatting and
queue policy, session engine), all running in `check` and CI. Browser-contract covers
the OPFS atomic-write probes and mounts the real `Diag.svelte`, `Lab.svelte`, and
`Fly.svelte` components. The webgpu (SwiftShader) CI leg from Phases 1–2 is **retired**
per [ADR 0009](decisions/0009-cpu-pipeline-webcodecs.md): the reduction stage is pure
TypeScript over WebCodecs capture, so determinism and goldens are node tests; the
`src/core/gpu/` and `src/core/cpu-pipeline/` spike modules remain as `/diag`
instruments, covered by node unit tests only. The full-loop video-E2E test landed in
Phase 5 (`src/core/full-loop.test.ts` — see Video-E2E); only the manual device
checklist is still pending, and its section describes the intended shape.

## Unit

- **Verifies:** framework-free core logic — routing decisions, capability-report shaping,
  and (as they arrive) lap semantics, record computation, the crossing state machine,
  speech formatting, storage-independent domain types. Pure functions and injected
  dependencies, no real platform APIs.
- **Does not:** touch the DOM, real OPFS, real camera, or Svelte components. Anything
  needing a real browser API belongs in browser-contract.
- **Where:** Node (Vitest), locally and in CI. Fast; the default level.
- **Gating:** yes. Runs in `check` and CI on every change.
- **Introduced:** Phase 1, and grows every phase.

## Browser-contract

- **Verifies:** behavior that needs a real browser — platform APIs jsdom cannot fake
  (today OPFS read/write plus the atomic-write and persistence probes; in Phase 6 the
  full storage contract suite — crash-simulation, quarantine, the never-block guarantee —
  against both `MemoryStorage` and `OpfsStorage`) and component/UI wiring that needs a
  real DOM (today the App capability-gate test and the `/diag` and `/lab` component
  tests, mounting the real components).
- **Does not:** verify reduction arithmetic (that is determinism & golden, in node) or
  assert full product flows over recorded video (that is video-E2E).
- **Where:** real browsers via Vitest browser mode with the Playwright provider —
  **Chromium** (gating) and **WebKit** (informational, per [ADR 0006](decisions/0006-ios-best-effort.md):
  cheap to run, kept green when it is free, never blocks a merge). Locally and in CI.
- **Gating:** Chromium gates; WebKit is informational.
- **Introduced:** Phase 1 (OPFS hello-world spike); the real storage contract suites land
  in Phase 6.

## Determinism & golden (node)

- **Verifies:** the pure-TS reduction stage produces exact, deterministic output —
  hand-constructed golden frames with known blob positions → exact per-strip hot-pixel
  counts; same clip → bit-identical `FrameSample` sequence; dt-scaled EMA behavior
  (dropped-frame sequences match gap-free equivalents); committed fixture byte-pins
  (clip, sidecar, energy JSON) regenerated and compared in `fixtures.test.ts`, rewritten
  with `UPDATE_FIXTURES=1`. Strip energy is an integer hot-pixel count so equality is
  exact, not tolerance-based. Since Phase 4 this category also carries the tier-aware
  corpus harness (`corpus.test.ts` over `corpus-harness.ts`): every committed clip replays
  through pipeline + crossing detector in node, must-pass regressions and unexpected
  known-limitation passes both fail CI (the ratchet ahead of the Phase 5 full-loop
  video-E2E).
- **Does not:** make crossing decisions (those are covered by unit tests against
  synthetic strip-energy sequences) and does not prove the deployed bundle computes the
  same on a real device — that is the `/lab` self-test.
- **Where:** node (Vitest), inside the unit project — the reduction is plain TypeScript
  fed by `ClipSource`/`SyntheticSource`, so no browser and no GPU are involved. This
  category replaced the Phase 1–2 GPU-golden rig (headless Chromium + SwiftShader) when
  [ADR 0009](decisions/0009-cpu-pipeline-webcodecs.md) moved the reduction to the CPU;
  the webgpu CI leg and its launch-flag config are retired.
- **Gating:** yes. Runs in `check` and CI on every change.
- **Introduced:** as GPU-golden, rig spiked in Phase 1, real GPU spike modules in
  Phase 2; reborn as node determinism/golden tests in Phase 3 (post ADR 0009).

## On-device self-test

- **Verifies:** that the deployed bundle computes what CI computed — the `/lab` self-test
  panel runs the bundled fixture clip through the pipeline on the device's CPU and compares
  against the committed energy JSON (semantic equality: per-frame integer energies +
  capture times, exact).
- **Does not:** run in CI, and is not a substitute for the node determinism suite's
  exhaustive vectors. It is a field sanity check on real hardware and a real deployed
  bundle — build, minification, and engine differences the CI runner never sees.
- **Where:** on the physical device, from the deployed URL. Human-initiated, results read off
  the screen.
- **Gating:** not a CI gate. It is a Phase 3 exit criterion on the Android phone (iOS
  best-effort) and a Phase 7 device-matrix line item.
- **Introduced:** Phase 3.

## Video-E2E

- **Verifies:** the whole timing loop on a fixed input — annotated raw luma clip →
  `ClipSource` replay (no video decode, no GPU — clips are raw Y planes read as bytes) →
  CPU reduction → crossing state machine → session layer → announcer, asserting detected laps,
  their directions, durations, discards, and the exact announcement decisions. Detection accuracy
  is ±1 frame (anchored in `docs/specs/product.md`); the roadmap sets a ±2-frame end-to-end
  budget as a working target; the authoritative fixture-tolerance definition is
  `docs/specs/detection.md` "Corpus match tolerance" (under Fixture formats). Deterministic replay makes this repeatable
  frame-for-frame.
- **Does not:** replace unit tests (a failure here does not localize the bug) and does not cover
  live-camera behavior — that is what the device spike and manual checklist measure.
- **Where:** node (Vitest) and CI — the whole loop is pure TS. The full-loop test is
  `src/core/full-loop.test.ts` (gating), in two variants: a clip variant (clip →
  `ClipSource` → CPU reduction → detector → session engine → announcer) and a
  strip-energy variant (energy sequences → detector onward, the fast twin). Both drive
  **synthetic** inputs, chosen deliberately so every expectation — crossing timestamps,
  lap durations, exact announcement decisions — is hand-computable and asserted with
  exact equality; real corpus clips exercise pipeline + detector via the corpus harness
  (see Determinism & golden), and a corpus-clip full-loop case is a future option.
  Corpus clips are the canonical asset; strip-energy JSON is a regenerable derivative.
- **Gating:** yes — the full-loop test gates, and so does the fixture corpus, tiered —
  `must-pass` fixtures require 100% detection / zero false positives; `known-limitation`
  fixtures assert documented behavior, and an unexpected pass of a known-hard case also
  fails (progress is ratcheted in).
- **Introduced:** the full-loop test landed in Phase 5; the fixture tooling and replay it
  depends on landed in Phase 3; the crossing-detection assertions filled in through Phase 4.

## Manual device checklist

- **Verifies:** what cannot be automated — real camera auto-exposure/focus/white-balance at a
  real gate, speech intelligibility over a running whoop, install-and-offline behavior,
  wake-lock holding through a session, thermal/soak behavior, device-loss recovery, and the
  cross-device matrix. Field acceptance is judged here.
- **Does not:** run unattended or block a merge. It is a human protocol with signed-off results,
  not code.
- **Where:** on physical devices, from the deployed URL, by a person following a written
  checklist. Android Chrome gates; iOS is best-effort per [ADR 0006](decisions/0006-ios-best-effort.md).
- **Gating:** release-gating by sign-off, not CI-gating.
- **Introduced:** device-matrix items begin in Phase 2 (the on-device spike); field-acceptance
  sign-off is a Phase 7 exit item.

## At a glance

| Category | Runs in CI | Gates | First appears |
|---|---|---|---|
| Unit | yes | yes | Phase 1 |
| Browser-contract | yes | Chromium gates; WebKit informational | Phase 1 (spike), Phase 6 (contract) |
| Determinism & golden (node) | yes | yes | Phase 1 (GPU-rig spike), Phase 3 (node, ADR 0009) |
| On-device self-test | no | phase-exit / device-matrix, not CI | Phase 3 |
| Video-E2E | yes | yes, tiered corpus | Phase 5 (Phase 3 tooling) |
| Manual device checklist | no | release sign-off | Phase 2 / Phase 7 |
