# Phase 4 — Crossing detection: state machine, session semantics, test mode at the gate

## Goal

The crossing state machine is precisely specified (written back into `detection.md`), implemented as pure TS, and validated against the tiered corpus: 100% of must-pass crossings detected with correct direction and timestamp, zero false positives on must-pass noise; known-limitation clips behave as the spec's mitigation story documents. Standing at the real gate, test mode beeps on every correct-direction hand-wave or fly-through and stays silent otherwise.

## Entry criteria

- Items 1–4 and 6–7 need only Phase 3's synthetic tooling — they start immediately.
- Items 5 and 8–10 (corpus harness, tuning loop, field session) require the rolling corpus (Phase 3 item 16) to have reached 30+ annotated events. A slipped field day therefore never stalls the pure-TS work.

## Scope

**In:** wave-detector specification + implementation, global-transient rejection, trigger auto-suggestion, EMA-pause feedback contract (with latency), synthetic sequence generator, session-semantics layer (pure TS, storage.md-shaped types), live end-to-end integration in `/lab`, test mode with audio confirmation.

**Out:** armed sessions, lap announcements, wake-lock productization (Phase 5). Persistence, product screens (Phase 6).

## Work items (dependency order)

1. **Resolve the wave-detector spec gaps as executable decisions, then write them into `detection.md`:** hot-strip hysteresis (enter/exit levels around the trigger); minimum participating strips; monotonicity tolerance of the wave front (the pilot recording says how many strips advance per frame at race speed — the tolerance must accommodate strip-skipping); plausible traversal-time window derived from ROI width and expected drone speed; **gate-center strip definition for an even strip count**; the canonical frame of reference for direction `ltr` (including mirrored/rotated cameras, tied to the Phase 3 orientation binding); behavior on partial traversals and simultaneous blobs; which frame anchors the crossing timestamp; **global-transient rejection** — an all-strips-simultaneous energy step (AE/AWB adjustment, lighting change, focus hunt) is not a wave and must be rejected; per Phase 2's lockability evidence this is mandatory on platforms where camera controls cannot be locked. The synthetic test suite *is* the executable spec — behavior must not be defined implicitly by the first implementation.
2. **Crossing state machine** (pure TS, `src/core`): per frame in — `FrameSample`; out — `crossing(timestamp, direction)` events plus a `crossingInProgress` flag. Injectable clock; no `Date.now()`/`performance.now()` inside core, ever. All windows in milliseconds (robust to dropped frames and thermal throttling), never frame counts.
3. **EMA-pause feedback contract** (the one place decisions flow back to the GPU): `crossingInProgress` drives the GPU pause uniform, with a **max-pause timeout** so a drone parked in the ROI after a crash cannot freeze the background model forever. The contract **states the real feedback latency**: with the 3-deep readback ring, the pause lands ~2–3 frames after the triggering frames — for a 3–6-frame crossing it may engage as the crossing ends. Verify analytically/synthetically that at the spec'd EMA time constant a fast crossing suffers negligible absorption regardless, and document in `detection.md` that the pause is a hover/crash mechanism, not a fast-crossing one. Dedicated `SyntheticSource` integration test **modeling the delayed pause** (applied N frames late): a hovering drone is not absorbed; a stuck flag recovers via the timeout.
4. **Synthetic strip-energy sequence generator** (test util, emits the Phase 3 JSON format): parameterized wave speed (including strip-skipping race-speed profiles), direction, strip count, noise floor, partial traversals, double-blob interference, global transients (lighting/AE step), hover, **frame-drop patterns, and capture-timestamp jitter** — the "robust to dropped frames and thermal throttling" claim gets tested, not just stated: a crossing must be detected correctly with N% random frame loss and realistic jitter.
5. **Corpus test harness** (needs corpus): replay regenerated strip-energy JSON through the machine at node speed; replay canonical clips through `VideoFileSource` → GPU → state machine to validate the full offline path. Tier-aware: CI fails on must-pass regressions **and on unexpected passes of known-limitation cases** (ratcheting progress in), so newly harvested hard fixtures never break the build.
6. **Trigger-level auto-suggestion** (spec gap — currently just "auto-suggested"): define deterministically (e.g. percentile of per-strip noise energy over an N-second quiet window × margin factor), unit-test, validate against the corpus when available, write into `detection.md`.
7. **Session-semantics layer** (pure TS, above crossings) — **using the `storage.md`-shaped Course/Session/Lap types verbatim** (defined in `src/core`, no persistence attached), so the shapes Phase 5 field-validates are the shapes Phase 6 freezes: test-mode/armed states, direction filter, min-lap-time debounce, first-crossing-starts-clock, lap emission, discard-last-lap (leaves current lap timing untouched), stop-drops-in-progress-lap. Decide whether min-lap-time debounce applies in test mode (spec gap); unit-test against crossing-event sequences.
8. **Tuning loop** (needs corpus): run the corpus through GPU-over-clips into the state machine; iterate defaults (EMA time constant, trigger suggestion, strip count); regenerate JSON caches via the Phase 3 tool after every tunable change; update `detection.md` when defaults move. **Escalation clause:** if the must-pass bar is not met after the loop, produce a per-condition failure analysis and decide explicitly between (a) tightened capture guidance (documented setup constraints: lighting, distance, placement), (b) reclassifying specific clips to known-limitation with written rationale, or (c) revising ADR 0003 — the gate must not become an open-ended stall.
9. **Live test mode in `/lab`:** wire CameraSource → GPU → state machine → session layer; gesture-primed confirmation beep (Phase 2 AudioService) per valid crossing.
10. **Field session:** hand-waves and fly-throughs at the real gate; correct-direction events beep, wrong-direction and walk-bys don't. Any false trigger is captured on the spot as a new clip fixture (recorder debug flag stays on) and tiered honestly.

## Verification

- CI: synthetic edge-case suite (incl. frame drops, jitter, global transients, delayed pause) green; corpus tier-aware regression suite green.
- Acceptance on the **must-pass tier**: 100% detection, correct directions, crossing timestamps within ±1 frame of annotated ground truth (synthetic sequences with mathematically known crossing frames verify the ±1-frame claim — real footage has no finer ground truth); zero false positives on noise/walk-through recordings. **Known-limitation tier:** behavior consistent with `detection.md`'s documented mitigation story (direction + debounce filtering, discard-last-lap recovery).
- Manual at the gate: test-mode beep behavior as specified.

## Risks retired

- **Underspecified wave detector** — "plausible time window", "gate-center strips", and global-transient handling become precise, tested definitions in the spec.
- **Camera-induced false positives** — rejection of all-strip transients is designed in, tied to Phase 2 lockability evidence, not discovered at the track.
- **EMA-pause deadlock/race and its latency illusion** — the only CPU→GPU feedback edge gets an explicit contract with realistic timing, a timeout, and an integration test.
- **Tuning-requires-a-drone / acceptance deadlock** — detector development is replayable; the tiered gate plus escalation clause makes the acceptance bar decidable rather than absolute-on-adversarial-footage (which would contradict `detection.md`'s own Known Limitations).
