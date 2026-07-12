# Test taxonomy

The kinds of test ChronoWhoop uses, why each exists, and where it runs. This is a
reference for choosing the right level for a given change, not an exhaustive list of
suites. Behavior is specified in `docs/specs/`; tests verify against those specs.

Six categories, introduced across the roadmap (`docs/plans/00-roadmap.md`). Concrete
script names live in `package.json` — refer to it rather than to any command written
here.

**Status (Phase 1):** unit tests exist and run in `check` and CI. The browser-contract
and GPU rigs exist as hello-world **spikes** — their job this phase is to prove the CI
harness can run each category before any product code needs it. On-device self-test,
video-E2E, and the manual device checklist are planned; the sections below describe the
intended shape.

## Unit

- **Verifies:** framework-free core logic — routing decisions, capability-report shaping,
  and (as they arrive) lap semantics, record computation, the crossing state machine,
  speech formatting, storage-independent domain types. Pure functions and injected
  dependencies, no real platform APIs.
- **Does not:** touch the DOM, the GPU, real OPFS, real camera, or Svelte components.
  Anything needing a real browser API belongs in browser-contract or GPU-golden.
- **Where:** Node (Vitest), locally and in CI. Fast; the default level.
- **Gating:** yes. Runs in `check` and CI on every change.
- **Introduced:** Phase 1, and grows every phase.

## Browser-contract

- **Verifies:** real browser-API behavior that jsdom cannot fake — today the OPFS
  read/write spike, and in Phase 6 the full storage contract suite (crash-simulation,
  quarantine, the never-block guarantee) run against both `MemoryStorage` and
  `OpfsStorage`.
- **Does not:** exercise the GPU pipeline (that is GPU-golden) or assert product
  end-to-end flows (that is video-E2E). It pins down one platform API at a time.
- **Where:** real browsers via Vitest browser mode with the Playwright provider —
  **Chromium** (gating) and **WebKit** (informational, per [ADR 0006](decisions/0006-ios-best-effort.md):
  cheap to run, kept green when it is free, never blocks a merge). Locally and in CI.
- **Gating:** Chromium gates; WebKit is informational.
- **Introduced:** Phase 1 (OPFS hello-world spike); the real storage contract suites land
  in Phase 6.

## GPU-golden

- **Verifies:** the WGSL reduction stage produces exact, deterministic output — exact-match
  golden vectors for the per-strip motion-energy reduction, plus determinism tests (same
  input → identical `u32` strip counts, run to run). Strip energy is an integer hot-pixel
  count so equality is exact, not tolerance-based.
- **Does not:** make crossing decisions (those are CPU/TS, covered by unit tests against
  synthetic strip-energy sequences) and does not prove any real phone's GPU agrees — that
  is what the on-device self-test is for.
- **Where:** headless Chromium with software WebGPU (SwiftShader; the exact Chromium flags
  live in `vitest.config.ts`) in CI, since GitHub-hosted runners have no GPU; also locally.
- **Gating:** yes, once it exists. The Phase 1 spike (hello-world compute dispatch +
  `mapAsync` readback) exists to prove the software-WebGPU rig runs in CI at all — if it
  could not, the whole automated GPU strategy needed a different answer before any WGSL was
  written.
- **Introduced:** rig spiked in Phase 1; real golden + determinism tests arrive in Phase 3.

## On-device self-test

- **Verifies:** that a real device's own GPU reproduces the goldens — the `/diag` panel runs
  the embedded golden vectors and one bundled clip through the device's GPU and reports the
  maximum deviation.
- **Does not:** run in CI, and is not a substitute for GPU-golden's exhaustive vectors. It is
  a spot check on hardware the CI runner will never have — notably the only automated GPU
  check possible on a real phone (and the only one possible at all on iOS).
- **Where:** on the physical device, from the deployed URL. Human-initiated, results read off
  the screen.
- **Gating:** not a CI gate. It is a Phase 3 exit criterion on the Android phone (iOS
  best-effort) and a Phase 7 device-matrix line item.
- **Introduced:** Phase 3.

## Video-E2E

- **Verifies:** the whole timing loop on a fixed input — annotated clip → WebCodecs decode →
  GPU reduction → crossing state machine → session layer → announcer, asserting detected laps,
  their directions, durations, discards, and the exact announcement decisions. Detection accuracy
  is ±1 frame (anchored in `docs/specs/product.md`); the roadmap sets a ±2-frame end-to-end
  budget as a working target, pending the authoritative fixture-tolerance definition that lands
  in `docs/specs/detection.md` (Phase 3/4). Deterministic replay makes this repeatable
  frame-for-frame.
- **Does not:** replace unit tests (a failure here does not localize the bug) and does not cover
  live-camera behavior — that is what the device spike and manual checklist measure.
- **Where:** driven from tests over recorded fixtures; runs wherever the pipeline runs (CI where
  the GPU rig allows). Corpus clips are the canonical asset; strip-energy JSON is a regenerable
  derivative.
- **Gating:** yes on the fixture corpus, tiered — `must-pass` fixtures require 100% detection /
  zero false positives; `known-limitation` fixtures assert documented behavior, and an
  unexpected pass of a known-hard case also fails (progress is ratcheted in).
- **Introduced:** the full-loop test lands in Phase 5; the fixture tooling and replay it depends
  on land in Phase 3; the crossing-detection assertions fill in through Phase 4.

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
| GPU-golden | yes (software WebGPU) | yes | Phase 1 (spike), Phase 3 (real) |
| On-device self-test | no | phase-exit / device-matrix, not CI | Phase 3 |
| Video-E2E | yes | yes, tiered corpus | Phase 5 (Phase 3 tooling) |
| Manual device checklist | no | release sign-off | Phase 2 / Phase 7 |
