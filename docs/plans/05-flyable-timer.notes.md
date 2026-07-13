# Staging notes — implement docs/plans/05-flyable-timer.md

Autonomous /implement-plan run (user pre-consented), post-ADR-0009. Started 2026-07-13
at `1396b1e` (Phase 4 committed).

## Pre-implementation

### Orchestrator decisions (declared before dispatch)

- **Speech queue policy: skip-stale-enqueue-next** (plan's ADR 0009 amendment default —
  no S22 speech-probe evidence yet). Never cancel an in-flight utterance; at most ONE
  queued announcement (the newest); stale queued announcements are dropped. Revisit
  after a device speech session (ADR 0008 slot stays open).
- **Announcement phrasing:** lap time formatted as "<seconds> <tenths>" digit text
  (e.g. 14.32 s → "14 3") — TTS reads it as the spec's terse "fourteen three" without
  hand-rolling number-to-words. "best" prefix / "best three" suffix per product.md.
- **Timer flow lives at `#/fly`** (new route, capability-gated like home): Phase 5 has
  no courses (Phase 6), so the screen carries an ephemeral inline course (direction +
  min lap time) and a setup-lite step reusing the lab's ROI/trigger-suggest components,
  then test → armed → stopped with the session-end lap table.
- **Interruption decisions (written into product.md by the UI implementer):**
  page hidden while armed → mark interruption, banner on return, timing continues
  (missed crossings are simply missed); camera track death while armed → surface
  prominently and stop the session, laps retained. Wake lock held for the whole
  camera-active flow (deviation from armed-only, noted in product.md per the plan).
- **Skipped (field):** 20-minute soak, stopwatch/video field acceptance.

## Phase logs

(appended by implementer subagents below)

## Wave A — records + announcer

Items 2 + 3: `src/core/records/records.ts`, `src/core/announcer/announcer.ts`
(+ tests). Decisions, each pinned by a unit test:

- **Rounding:** announcements round the duration to the nearest tenth of a
  second, half up — 14.32 s → "14 3", 14.35 → "14 4", 14.96 → "15 0". Rounding
  (vs truncation) keeps the spoken time within ±0.05 s of the true one.
- **Record ties:** first occurrence wins (strict `<` everywhere) — for best
  lap, best-three windows, and cross-session course records alike. A lap/window
  that only TIES a standing record is not a new record and is not announced.
- **Cross-session records (`courseRecords`):** best lap is the global minimum
  over all sessions' valid laps; best-three windows are within-session only —
  laps in different sessions are never consecutive, so a window spanning a
  session boundary would be meaningless.
- **"best" announcement semantics:** announced only on IMPROVEMENT over a
  previously existing record of the same kind. The first valid lap is trivially
  the session best and is NOT announced (it would be noise on lap 1 of every
  session); symmetrically, the first-ever best-three window is not announced —
  only a window strictly beating a previous window is. product.md's "New
  session-best …" is read as "newly beats the session record", which requires a
  record to exist.
- **`computeAnnouncementRecords(laps, newLap)`** takes the session's full lap
  list with `newLap` already appended as the last element — exactly what
  SessionEngine's `onLap(lap, session)` provides — and throws on a mismatched
  call. Best-three improvement is detected as
  `bestThreeConsecutive(all) < bestThreeConsecutive(all minus newLap)`; any
  window containing the last lap necessarily ends at it, so no window-position
  bookkeeping is needed.
- **Speaker seam:** `interface Speaker { speak(text): { settled: Promise<void> } }`.
  AudioService satisfies it structurally (SpeechHandle has `settled`), so no
  adapter class exists; a type-level test pins the assignability. `settled`
  never rejects per the AudioService contract, but the announcer attaches a
  rejection handler anyway so a foreign Speaker cannot wedge the queue.
- **Queue policy (skip-stale-enqueue-next, per orchestrator decision):**
  nothing in flight → speak immediately; in flight → hold only the newest
  pending text; a newer announcement replaces it and the replaced text is
  logged `dropped-stale`; on settle the pending text is spoken. `cancel()` is
  never called. Every arrival-time decision
  (`spoken-immediately` | `queued` | `dropped-stale`) is recorded in
  `announcer.decisions` and mirrored to an optional `onDecision` callback for
  the full-loop CI test; speaking a queued item on settle adds no extra
  decision entry (the log records arrival-time policy, not playback).
- **No `announceTestCrossing`:** test-mode feedback is the beep (product.md),
  the caller's concern via AudioService directly.

## Wave B — full-loop CI test

Item 8: `src/core/full-loop.test.ts` (node unit project — per ADR 0009 there
is no GPU leg). Two variants over the same SessionEngine + Announcer rig
(injected wall clock, FakeSpeaker with test-controlled settle promises; no
timers anywhere):

- **Clip variant (canonical):** five synthetic 40-frame fly-through segments
  (64×36, 20 ms cadence, blob 6 px @ +3 px/frame) concatenated at integer
  offsets 2/16/29/31/45 s, round-tripped through `encodeClip`/`decodeClip`,
  then ClipSource → DetectionPipeline → attachDetectorToPipeline →
  CrossingDetector → SessionEngine → computeAnnouncementRecords → Announcer.
  Hand-computed detector stamp: segment frame 13 → crossing at start+260 ms,
  asserted with exact equality (integer timestamps by construction). Pins:
  5 crossings detected; onArmedStarted(2260); laps exactly [14000, 13000,
  16000] ms; the 31.26 s crossing debounced (2000 < minLapTime 3000) WITHOUT
  resetting the window (lap 3 = 45260−29260); announcement decisions as an
  exact sequence exercising all three policy actions ("14 0" held in flight
  across laps 2–3 → "best 13 0" queued then dropped-stale, "16 0" queued and
  spoken on settle); in-progress lap started at 45260; stop() drops it and
  retains 3 laps; discardLastLap() flips lap 3 and sessionRecords loses the
  only best-three window while best lap survives.
- **Energy variant (fast twin):** `generateSyntheticSequence` waves (2
  strips/frame, width 3 → crossing at 20·(startFrame+3), matches generator
  ground truth exactly) → CrossingDetector directly. Adds a wrong-direction
  rtl wave (detector reports it; the session direction filter drops it —
  lap 2's 12500 ms duration pins that it didn't perturb the debounce window)
  and a best-lap improvement: texts exactly ["14 0", "best 12 5", "13 0"]
  (lap 1 never "best", first-ever best-three window not announced — Wave A
  semantics). Speaker settles between laps → all spoken-immediately.
- **Segment concatenation note:** SyntheticSource emits one crossing per
  instance; segments concatenate cleanly because each starts/ends at the bare
  background level and the reducer clamps the inter-segment dt to 1000 ms.
  Blob intensity is 200 (not the fixture-style 240) so post-crossing EMA
  residue at 20 ms cadence stays comfortably below the diff threshold 25
  (two unpaused bumps ≈ 0.116·(200−32) ≈ 19.5).
- **Synthetic clips, not corpus (deliberate substitution):** plan item 8 says
  "annotated corpus clip"; both variants instead drive synthetic inputs so
  every expectation (crossing timestamps, durations, exact announcement
  decisions) is hand-computable and asserted with exact equality. Real corpus
  clips already exercise pipeline + detector via the corpus harness; a
  corpus-clip full-loop case is a future option.
- **Phase 6 seam:** `createArmedSessionRig` owns the onLap hookup (records →
  announce); the plan's future never-block test wraps that onLap with a
  slow-storage fake whose persist promise the test controls.

## Wave C — fly screen (items 1, 4, 5, 6, 7)

`#/fly` route (capability-gated, NOT exempt), `src/ui/fly/*`,
`src/ui/screens/Fly.svelte`, minimal Home. Decisions/assumptions:

- **Flow state:** `FlyPhase = 'setup' | 'test' | 'armed' | 'stopped'` on
  `createFlySession` (`fly-session.svelte.ts`, interface in `fly-session.ts`),
  mirroring the lab-session pattern. One `SessionEngine` per mount (injected
  wall clock `() => new Date()`), one `Announcer` over `getAudioService()`;
  the ephemeral inline course (name "Quick session", direction + min-lap-time
  3000 ms default, `crypto.randomUUID()` id) is built fresh per
  startTest/arm. `SessionDetectionConfig` snapshot at arm =
  `{ tunables: current tunables, detector: live CrossingDetector.config }`.
- **FlySession extends LabSession** so the shared calibration components
  (RoiOverlay, energy bars, trigger-suggest pattern) compose without touching
  lab files. Consequence: the tee stays in the chain to honor
  `addFrameListener` honestly (fly itself registers no frame listeners, no
  recorder) — 3 lines, negligible cost, keeps one seam instead of two.
- **Armed running clock (rAF, the bridge rule):** crossing timestamps are
  capture-domain with no defined relation to performance.now(), so on
  onArmedStarted/onLap the session records `performance.now()` at event
  arrival (`ArmedClockBase`); the armed screen's rAF loop writes
  `performance.now() − arrivalPerfMs` straight to a DOM node's textContent.
  Approximation: display lags true lap time by capture→event latency
  (≲ 1 frame + pipeline cost) and rebases every lap, so error never
  accumulates; lap DURATIONS remain pure capture-domain in the engine.
  `clockStarted` is the only reactive mirror (lap-level event).
- **Audio priming** rides the Start-camera gesture (`primeOnGesture`),
  best-effort: failure surfaces as a retryable warning, never blocks capture.
  Test-mode feedback is `audio.beep()` per Wave A (no announcer involvement);
  discard is silent, records recompute from the lap snapshot.
- **Wake lock**: acquired in startCapture, disposed in teardown — whole
  camera-active flow (orchestrator decision; deviation from armed-only noted
  in product.md). Loss shows as a "screen may sleep" warning.
- **Interruptions (product.md updated, Session lifecycle):** hidden-while-
  armed sets a pending flag; on visible it becomes a dismissable banner
  ("detection was interrupted — laps during the gap were not detected");
  session stays armed, timing continues. Camera failure ('unavailable' /
  track-ended etc.) while armed → capture teardown + auto-stop with
  `stopCause: 'camera-lost'`, laps retained, prominent error on the stopped
  screen; while in test mode it falls back to setup.
- **Test seams (browser test `fly.browser.test.ts`):** `onsession` prop on
  Fly.svelte hands the created session to the test; `injectCrossing(event)`
  feeds `engine.onCrossing` directly — the smallest honest seam, since
  driving deterministic optical crossings through a captureStream is flaky.
  The captureStream scene is deliberately near-static (frames flow, detector
  never fires) so injected timestamps fully determine laps. Scope: setup
  idle without getUserMedia, arm gating, full injected flow (start → laps →
  wrong-direction/debounce ignored → discard → stop → lap table with
  best/discarded/best-three assertions → new session keeps camera), test-mode
  count + camera-death auto-stop. Wake lock is asserted only as "tolerated"
  (headless support varies).
- **Pure helpers unit-tested:** `fly-format.ts` (running clock s.t / m:ss.t
  truncating to elapsed tenths, lap seconds 2 dp, locale-independent local
  HH:MM:SS for time of day).
- **Home** replaced with a minimal honest screen (name, Fly button, small
  diag/lab footer links); the gate test's Home-text assertions updated
  (`app-gate.browser.test.ts` — outside the listed scope but broken by the
  Home change).
- **Amnesia:** no persistence anywhere; the stopped screen says so
  ("Nothing is saved yet — … evaporates on reload").

## Review fixes — announcer + records (2026-07-13)

All five accepted (none disputed). `src/core/announcer/*`, `src/core/records/records.test.ts`;
`full-loop.test.ts` untouched — it uses `.decisions` + default constructor only, and both
variants settle every utterance, so the new watchdog timers are always cleared.

- **Settle watchdog (TS#1, medium):** a wedged WebSpeech engine losing the terminal
  event no longer kills the queue. Each utterance races `settled` against an injectable
  timer (`AnnouncerOptions.settleTimeoutMs`, default 8000 ms — longer than any lap
  announcement — plus `setTimeoutFn`/`clearTimeoutFn` seams so tests drive it without
  real timers). Timeout ⇒ treated as settled, logged `'settle-timeout'`, queue advances.
  A LATE real settle after a timeout is a no-op: finishing an utterance clears the
  active-utterance id (speaking the pending one installs a fresh id), so the stale
  settle arm fails the identity check. Normal settles clear the watchdog (pinned: no
  timer leaks).
- **Synchronous `speak()` throw (TS#2, low):** try/catch in `#speakNow` — treated as
  immediately settled with a distinct `'speak-failed'` decision (kept separate from
  `'settle-timeout'` so diagnostics distinguish "engine wedged" from "engine gone");
  the watchdog is cleared and the pending text still speaks. `AnnounceAction` is now
  the 5-value union.
- **`onDecision` removed (simplicity#2, minor):** its only consumer was a mirror test
  (deleted). `AnnouncerOptions` stays as the home for the watchdog options.
  `announcer.decisions` is the single observation surface.
- **courseRecords cross-session best-three tie (test-rigor#3, low):** pinned that the
  earlier session wins on equal `totalMs` (the surviving `<` vs `<=` mutant now dies —
  the tied windows have different splits so the assertion is discriminating).
- **`Announcer.reset()` (architect#5a, nit):** clears the pending queued text only, so
  stop/arm boundaries cannot leak a stale announcement into the next session. The
  in-flight utterance is left to finish (cancel() is never called per policy); its
  settle then speaks nothing. Logs no decision. The fly screen may wire this at
  stop/arm.

`bun run typecheck && bun run lint && bun run test`: green (53 files, 656 tests).

## Review fixes — docs write-back (2026-07-13)

Docs-only fixer pass over the Phase 5 review findings (docs#1–#5). No code
touched; wording describes policy, not internals, to stay true alongside the
parallel announcer watchdog fix.

- **docs#1 (ADR 0008 write-back):** "Speech queue policy input" decision row
  filled — interim default skip-stale-enqueue-next chosen without device
  evidence (`cancel()` never called; one pending slot, newest wins; watchdog
  skips a wedged utterance after a timeout), provisional until the S22
  speech-probe session; Speech section notes Phase 5 shipped ahead of the
  measurements. product.md Speech feedback gained the observable queue policy
  in user terms (queued while speaking, newest survives, never cut off
  mid-word, stuck engine skipped after a timeout).
- **docs#2:** product.md Speech feedback gained the announcement semantics —
  nearest-tenth rounding (half up), "best"/"best three" only on improvement
  over an existing session record, first lap / first-ever window not
  announced, ties never announce.
- **docs#3:** product.md Records — best-three windows never span a session
  boundary; course all-time best three = best within-session window.
- **docs#4+#5:** testing.md status paragraph moved to Phase 5 (records/
  announcer/session-engine coverage, `Fly.svelte` browser mount, full-loop
  test landed); Video-E2E section now records that `src/core/full-loop.test.ts`
  exists (node, gating, clip + strip-energy variants) with the honest
  synthetic-inputs caveat and corpus-clip full-loop as a future option. The
  synthetic-vs-corpus substitution recorded as deliberate in Wave B above.
- **architect#6 overlap:** product.md wake-lock sentence ("loss is surfaced
  in the UI") left as-is — the parallel test-mode-warning fix makes it true.

## Review fixes — shared capture extraction (2026-07-13)

Phase 5 review findings on src/ui/** (parallel fixers own announcer/records
and the spec docs). All verified with typecheck + lint + unit + Chromium
browser suites green (webkit browser project cannot launch on this host —
missing system libraries, unrelated to the change).

1. **Shared capture session extracted** — `src/ui/shared/capture-session.ts`
   (interface `CaptureSession`, the former LabSession surface verbatim) +
   `capture-session.svelte.ts` (`createCaptureSession(options)`, the former
   createLabSession body: camera → CameraSource → tee → DetectionPipeline,
   wake-lock generation guard, external-death handling, EMA reset on setRoi)
   with three extension hooks: `onStartGesture` (fires synchronously inside
   startCapture before any await, so gesture-gated APIs still work — fly
   primes audio), `onCameraFailure` (after external-death teardown — fly
   auto-stops/falls back), `onTunablesUpdated` (fly forwards triggerLevel to
   its live detector). `createFlySession` now COMPOSES a capture session and
   delegates the shared surface via getters; the ~140-line fork is gone.
   Judged deviation: `createLabSession` was NOT kept as a thin wrapper — the
   lab has zero lab-only session bits (cameraStats/ringBuffer are part of the
   shared surface; the ring-buffer seam is an architecture rule), so a wrapper
   would be dead indirection. lab-session.ts/.svelte.ts are deleted; Lab.svelte
   calls createCaptureSession directly and all lab panels type against
   CaptureSession. RoiOverlay is typed against CaptureSession.
2. **Detector-attach adapter extracted and tested** —
   `src/ui/shared/detector-attachment.ts`: `attachDetectorToCaptureSession
   (session, detector, onCrossing) → detach` (detach unsubscribes AND
   un-pauses), plus the `detectorTriggerLevel` clamp (previously duplicated
   too). Used by both TestModePanel and fly-session.
   `detector-attachment.test.ts` (node): synthetic two-wave sequence through a
   stub session (real listener registry + pause recorder) into a real
   CrossingDetector + armed SessionEngine — asserts the lap duration equals
   the generator ground-truth delta, that setPause reached the stub (true
   during candidates, false after), and that after detach a replay of the
   whole sequence produces nothing (closing the "arm() stops attaching and the
   suite stays green" hole).
3. **Trigger-suggest controller extracted** —
   `src/ui/shared/trigger-collection.svelte.ts`
   (`createTriggerCollection(session)`: poll loop, observedSpanMs progress,
   tunables-identity abort $effect, apply, unmount cleanup; must be called in
   component init since it owns its $effects). Used by TestModePanel and
   FlySetupPanel; markup stays per-panel.
4. **Arm-from-test candidate carry-over fixed** — fly-session `arm()` now
   calls `detector.reset()` after attachDetection (a crossing begun in test
   mode can no longer start the armed clock; on a freshly attached detector
   the reset is a no-op). Pinned in detector-attachment.test.ts: a candidate
   driven mid-flight completes its crossing in the control run, and with a
   reset between (what arm() does) the pre-arm candidate never completes.
5. **Min-lap input hardened** — FlySetupPanel: clearing the field
   (Number('') = 0) silently disabled the debounce; empty/invalid input is now
   ignored and the effective value re-rendered into the input.
6. **Wake-lock warning on every camera-active fly screen** — new shared
   `WakeLockWarning.svelte`; FlyTestPanel now shows it too (it had none),
   FlySetupPanel/FlyArmedPanel use the component.
7. **Speech-health hint while armed** — FlyArmedPanel polls
   `audio.pendingUtteranceCount` at 1 Hz and shows "speech may be stuck —
   spoken lap times are queuing up" when the count stays above 1 across
   consecutive polls (the announcer holds at most one in flight + one queued,
   so a sustained backlog means no terminal events are firing). Core watchdog
   is the parallel announcer fixer's.
8. **quick-course wallClock** — the finding's premise VERIFIED true:
   `svelte/prefer-svelte-reactivity` errors on raw `new Date()` in .svelte.ts
   modules (confirmed by attempting the inline). Resolution per the finding:
   the one-line named export stays in quick-course.ts (now with a comment
   naming the lint), the platform-testing `wallClock` test block is deleted.

Shared-module inventory (`src/ui/shared/`): capture-session.ts,
capture-session.svelte.ts, detector-attachment.ts (+ .test.ts),
trigger-collection.svelte.ts, WakeLockWarning.svelte (new);
RoiOverlay.svelte, roi-interaction.ts (+ .test.ts), energy-bars.ts,
energy-math.ts (+ .test.ts) (moved from src/ui/lab, importers updated).
`src/ui/diag/strip-bars.ts` stays in diag (diag panels import it);
shared/energy-bars imports it from there. Behavior is otherwise identical:
lab + fly browser suites pass unchanged (only the two svelte-ignore
state_referenced_locally annotations for the created-once controller were
added, matching the existing screen-session pattern).

## Review fixes — test augmentation (2026-07-13)

Three browser tests added to `src/ui/fly/fly.browser.test.ts` (Chromium
fake-camera rig, all vi.waitFor-driven, no sleeps, no production-code
changes — the existing injectCrossing seam and DOM classes sufficed):

- **Hidden-while-armed interruption (test-rigor#2, medium):** fakes
  hide/show by shadowing `document.visibilityState` with a configurable
  own-property getter and dispatching `visibilitychange` (fly-session
  listens on document; the shadow is deleted in afterEach so the prototype
  getter resumes). Pins: hiding in setup produces NO notice; hiding while
  armed shows nothing until return, then the product.md-worded dismissable
  banner; the session never auto-stops (phase stays 'armed'), Dismiss
  clears it, and a post-gap injected crossing still records a lap.
- **Best-three positive highlight (test-rigor#4, low):** four valid laps
  (20.00 / 14.32 / 13.33 / 16.00) so the window is laps 2–4 and the
  assertion discriminates — exactly rows 2–4 carry `best-three`, row 1
  does not; the legend shows "best three consecutive — 43.65 s total" and
  the stopped-header records dl shows 43.65. The existing
  absence-after-discard assertion is kept unchanged.
- **rAF clock liveness + rebase (test-rigor#5, low):** after the first
  injected crossing the `.clock` element matches /\d+\.\d/ and a later
  waitFor sample exceeds an earlier one (the rAF loop really writes);
  after letting it accumulate ≥0.3 s, a lap-completing crossing rebases
  the display below the pre-lap reading.

`bun run typecheck && bun run lint && bun run test && bun run test:browser`:
green (unit 54 files / 658 tests; browser 5 files / 23 tests).
