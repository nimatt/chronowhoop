# Phase 5 — Flyable timer: armed sessions, speech, wake lock (no persistence)

## Goal

Actually practice with it: arm, fly, hear "fourteen three" / "best fourteen one" / "best three" every lap, discard a bad lap after a crash, stop, and read the session's lap table on screen. Data evaporates on reload — by design. This is the earliest moment the app gets real use at the track, the real-world validation of the whole product loop before storage or product-UI investment — and the moment the full arm/lap/discard/announce loop comes under CI, so later phases can't regress it undetected.

## Scope

**In:** armed-session flow end to end (in-memory, storage.md-shaped model), speech announcer with evidence-based queue policy, records module, wake-lock service, live armed screen (rAF-driven), interruption handling incl. GPU device loss, full-loop CI test, soak + field acceptance.

**Out:** any persistence (OPFS, courses) — Phase 6. Course/session review product screens beyond the session-end lap table. Export/import, install flow — Phases 6–7.

## Work items (dependency order)

1. **In-memory session model** using the `storage.md`-shaped Course/Session/Lap types verbatim (already established in Phase 4's session layer; defined in `src/core`, no persistence attached): ordered lap list with `valid`/`discarded` status, lap durations from capture-time timestamps. Phase 6 must be able to add only schemaVersion envelopes, validators, and migrations around these shapes — if a shape needs to change during this phase's field validation, change it here *and* in `storage.md` in the same commit.
2. **Records module** (pure TS, computed never stored per ADR 0004): best valid lap; best three consecutive with the discarded-lap-breaks-window rule. Exhaustive unit tests: windows spanning discards, <3 valid laps, all-discarded, ties.
3. **Speech announcer** (on the Phase 2 AudioService): terse phrase formatter (14.32 → "fourteen three"; "best" prefix for session-best lap; "best three" suffix) as a pure, unit-tested function. **Queue/overlap policy chosen from the Phase 2 device-matrix speech evidence** — cancel-and-replace only if `cancel()`-then-`speak()` proved reliable on both platforms; otherwise skip-stale-enqueue-next (never let a slow utterance delay the next lap). Policy is pure logic behind an announcer interface, unit-tested; re-priming after background/foreground handled per the Phase 2 findings.
4. **Wake-lock service:** acquire on arm, re-acquire on `visibilitychange`, release on stop; surface loss in UI. Generalizes Phase 3's `/lab` wake lock. Decide scope (spec says armed only; recommend extending to the whole camera-active flow — long calibration dims screens — and note the deviation in `product.md`).
5. **Live armed screen** (thin Svelte): glanceable big numerals — running current-lap clock, last lap, lap count, session best; stop and discard-last-lap controls sized for mid-flight thumbs; armed-state visual. Per the Phase 3 bridge rule: the running clock is **rAF-driven canvas/DOM writes, not reactive state ticks**; `$state` carries only lap-level events.
6. **Interruption handling** (spec gap — write the decision into `product.md`): behavior when the page hides mid-armed-session (phone call, notification) — camera and rVFC stop when hidden; at minimum detect the gap, mark the timeline, inform the user. **Also: GPU device loss while armed** (can happen while visible, under thermal load) — run the Phase 3 recreation path and resume, or clearly surface the failure; never a silently dead pipeline with a running clock.
7. **Session-end lap table** rendered from the in-memory model (lap #, duration 2 dp, time of day, status, best-lap and best-3 highlights, strikethrough discards) — becomes the persisted session view in Phase 6 unchanged.
8. **Full-loop CI test** (the pieces all exist now — annotated clips, `VideoFileSource`, announcer interface, injected clock): drive an annotated corpus clip through FrameSource → GPU → state machine → session layer → announcer interface in the GPU CI leg, and its regenerated strip-energy JSON through the same stack minus GPU as the fast node variant. Assert lap count, durations within tolerance, discard behavior, and the **exact announcement strings/queue decisions**. From here on, regressions in the product loop are caught in CI, not by flying — the most expensive verification channel the project has.
9. **Soak test:** 20-minute armed session on-device; watch thermal fps degradation, memory growth (ring buffer), rVFC starvation on focus loss, and device-loss recovery under thermal pressure.
10. **Field acceptance:** real flying sessions; compare spoken laps against hand stopwatch and frame-by-frame video review; short-lap speech overlap verified aurally on the Android phone (and iOS if available). Every session harvests clip fixtures via the debug recorder.

## Verification

- CI: full-loop test (GPU and node variants) green; unit suites for records, phrase formatter, announcer policy, session-model edge cases (all with injected clock).
- Manual on the Android phone at the track (iOS too if available, non-gating): full session flow, discard mid-session, screen never sleeps, announcements never overlap or lag on short laps, interruption and device-loss paths behave as documented.
- Soak and stopwatch comparison recorded in a short report.

## Risks retired

- **The product loop itself** — arming semantics, announcement timing, and glanceability validated by real use before persistence and product UI are built around them; from here on the developer is a daily user of the tool.
- **Product-loop regressions caught only by flying** — the full-loop CI test guards the arm/lap/discard/announce chain through Phases 6–7's rework.
- **Speech overlap on short laps** — policy grounded in Phase 2 device evidence, pure-tested, device-verified.
- **Schema drift between field-validated model and storage spec** — the shapes being validated *are* the storage.md shapes.
- **Thermal/memory sustainability; wake-lock, interruption, and device-loss edges** — resolved inside the session state machine now, not retrofitted.
