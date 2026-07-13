# Staging notes — implement docs/plans/07-pwa-portability-v1.md

Autonomous /implement-plan run (user pre-consented), post-ADR-0009. Started 2026-07-13
at `1c01d73` (Phase 6 committed).

## Pre-implementation

### Orchestrator decisions (declared before dispatch)

- **Import merge rules (plan item 2, spec gaps decided here, written into storage.md):**
  refuse newer-than-app schemaVersion with an "update the app" message (the
  'unsupported-version' error kind from Phase 6); merge by id — unknown added, existing
  skipped, counts reported; courses applied before sessions; orphan sessions (courseId
  matches nothing after merge) imported anyway and rendered with an "unknown course"
  placeholder; local settings always win (imported settings ignored except nothing —
  fully ignored).
- **Backup nudge "recent" definition (item 3):** nudge after a stopped session when
  there are sessions newer than `lastExportAt`, AND (no export ever OR lastExportAt
  older than 7 days). Pure function with injected clock.
- **Offline verification adapted:** no standalone Playwright — the precache-completeness
  check is a node test over the built `dist/` (skipped when dist absent; CI runs it
  after build), plus the manual airplane-mode item in the device-matrix runbook.
  Recorded as a deviation from plan item 4's "Playwright offline test".
- **E2E flows adapted (ADR 0009 amendment):** the vitest browser rig IS the E2E harness
  (real App + injected MemoryStorage/fake camera + crossing seam); Phase 7 adds the
  export→import round-trip leg on a fresh storage context with count/record assertions.
- **iOS install instructions:** minimal static note (no device to verify against);
  beforeinstallprompt UI is the real deliverable (Android/desktop Chromium).
- **Skipped (field):** real-world tuning pass (9), device-matrix execution + field
  acceptance execution (10, 11 — the checklist/protocol DOCUMENTS are written).

## Phase logs

(appended by implementer subagents below)

## Wave A — import + nudge core

Items 2 (import logic + fuzz) and 3's logic half (backup nudge predicate). No UI.

- **Files:** `src/core/storage/import.ts` (parseImportFile, computeImportPlan,
  importIntoStorage), `import.test.ts`, `import-fuzz.test.ts`,
  `backup-nudge.ts` + `backup-nudge.test.ts`; `memory-storage.ts` and
  `opfs-storage.ts` importAll now delegate to the shared `importIntoStorage`;
  contract suite's Phase 6 importAll stub-pin replaced with real merge pins
  (runs in all three rigs: memory/node, fake-OPFS/node, real-OPFS/browser);
  storage.md import + nudge paragraphs rewritten per the orchestrator
  decisions. Mechanical fix outside storage: `session-persister.test.ts`'s
  Storage-rebinding helper now forwards importAll's envelope argument
  (compile-time only; the stub previously took no argument).
- **Decisions/assumptions made here:**
  - Both implementations share one executor (`importIntoStorage`) so merge
    semantics cannot drift; it takes the four Storage methods it needs
    (structural `ImportTarget`), and the implementations pass `this`.
  - Duplicate ids WITHIN one envelope: first occurrence wins, later ones count
    as skipped — counts always match what lands, re-import stays idempotent.
  - A zero-adds import performs no writes (and therefore succeeds with all-skip
    counts even in a read-only tab); any import that must write in a read-only
    OpfsStorage fails with 'write-failed' as usual.
  - Known limitation (accepted): importAll derives existing session ids from
    listSessions, which skips locally unreadable files. A session file refused
    in place as 'unsupported-version' is therefore invisible to the merge, and
    an import carrying the same UUID would overwrite it via saveSession. Only
    reachable via version-rollback + import of the same session; not worth a
    strict listing that would fail every import while any unreadable file
    exists.
  - `shouldNudgeBackup`'s injected clock is epoch milliseconds
    (`now: number`, i.e. `Date.now()`); boundaries are strict per the
    orchestrator definition — a session starting exactly AT lastExportAt is
    covered, an export exactly 7 days old is still recent.
  - Item 3's persist()-denied persistent indicator is UI → Wave B, skipped
    here as directed.
- **Fuzz coverage** (`import-fuzz.test.ts`, all seeded/mulberry32): truncation
  at every byte offset of a pretty-printed export; 500 type-swap mutations at
  random document sites; wrong top-level JSON types; huge-but-valid-ish
  structures (200×50-lap sessions, 1MB unknown key, 100k-deep nesting, 1MB
  unterminated token); prototype-pollution keys (`__proto__`, constructor/
  prototype, incl. the v0 migration spread path) with Object.prototype
  verified intact; newer schemaVersion → 'unsupported-version' with "update
  the app"; property test over 400 random strings. Invariant everywhere:
  parseImportFile returns a valid envelope or throws StorageError, never
  anything else.
- **Verify:** typecheck, lint, `test` (824), `test:browser` (67) all green.

## Wave B1 — delivery + import + nudge + install UI

Items 1 (export delivery), 2's UI half (import on Home), 3's UI half (nudge +
persist-denied indicator), 5 (install-flow UI).

- **Files:** `src/ui/shared/deliver-export.ts` (share sheet / anchor-download
  delivery + browser test), `src/ui/shared/export-action.ts` (`runExport` —
  the one product export flow, shared by Home and the nudge),
  `src/ui/pwa-install.svelte.ts` (beforeinstallprompt capture + prompt()),
  `Home.svelte` (export via runExport, import file input + result/error
  notices, install button, persist-warning rewording),
  `SessionView.svelte` ("Unknown course" placeholder for orphan sessions),
  `FlyStoppedPanel.svelte` (nudge block only, per the wave split) +
  `FlyFlow.svelte` one-line `{context}` pass-through,
  `portability.browser.test.ts`, `backup-nudge.browser.test.ts`.
- **Delivery decisions (item 1):** `canShare({files})` is the capability
  probe; share-sheet cancel (AbortError) is reported as 'cancelled' — no
  error notice, and NO lastExportAt update (the data never left the device).
  Any other share() failure falls back to the anchor download. Both a
  completed share and a triggered download count as delivered and record
  lastExportAt — the anchor path cannot observe a cancelled save dialog, so
  triggering the download is the best available signal. Recording stays
  fire-and-forget through CoursesRepo (settings mirror + nudge react to it).
- **Import UI decisions (item 2):** Home gains a hidden file input (accept
  .json) behind an "Import data" button; input value is reset after each pick
  so re-importing the same file (the documented mid-import-failure recovery)
  re-fires. After importAll, BOTH repos are refreshed (reload + refresh — the
  invalidation rule; importAll writes behind their backs). Counts render as
  "Added N courses and M sessions; skipped X courses and Y sessions already
  present." Errors: 'unsupported-version' shows its own update-the-app
  message; 'corrupt' shows "Not a valid export file — <detail>". Import is
  not disabled in a read-only tab: a zero-add import legitimately succeeds
  there, anything that must write surfaces its 'write-failed' error.
  SessionView verified for orphan sessions: the course link already degraded
  to a home link; the header now says "Unknown course" (was "Session") once
  courses have loaded and the id matches nothing.
- **Nudge (item 3 UI):** lives in FlyStoppedPanel behind an OPTIONAL
  `context` prop (panel renders unchanged without it), so the parallel fly
  wave's direct mounts stay valid; FlyFlow passes the context. On mount the
  panel refreshes SessionsRepo (flights persist behind the repo's back; the
  session file exists from arm time, so the just-flown session is counted)
  and ensures courses are loaded before evaluating shouldNudgeBackup (clock
  captured once at mount). "Export now" reuses runExport; a successful export
  updates settings.lastExportAt reactively, which retracts the nudge and
  leaves an "Exported <file>" confirmation. Persist-denied indicator: Home's
  existing warning verified persistent (renders whenever persistenceStatus is
  not persisted), reworded to "Storage may be cleared by the browser —
  persistent storage was not granted. Export regularly to keep a backup."
  PersistenceStatus cannot distinguish denied from not-yet-requested, so one
  message covers both.
- **Install UI (item 5):** module-level beforeinstallprompt listener in
  pwa-install.svelte.ts (in App's static import graph via Home, so registered
  at startup); preventDefault + stash the event; `available` also requires a
  non-installed display mode via detectDisplayMode (standalone/fullscreen/
  minimal-ui all count as installed); prompt() is single-use so the button
  hides immediately on click; 'appinstalled' clears too. iOS: NO instructions
  sheet shipped — the capability gate blocks iOS anyway (no
  MediaStreamTrackProcessor → unsupported screen), so an install note would
  be unreachable/moot; revisit with a device if the gate ever opens (honest
  deviation from plan item 5's "iOS instructions sheet").
- **Tests:** portability.browser.test.ts (import merge counts + imported
  course visible + orphan "Unknown course", re-import skip counts, corrupt
  file, newer-version refusal, share-sheet delivery recording lastExportAt,
  share-cancel recording nothing, install button appear→prompt→hide);
  deliver-export.browser.test.ts (delivery selection with injected fake
  navigators); backup-nudge.browser.test.ts (nudge shown with unexported
  session, quiet after fresh export, Export-now records + retracts).
- **Verify:** typecheck, lint, `test` (831), `test:browser` (82), build all
  green (counts include the parallel fly wave's in-flight work).

## Wave B2 — orientation + precache + runbooks

Item 7's orientation binding (deferred from Phase 6 — see the 06 notes
Deviations), item 4's automated half (precache completeness), items 10–12 as
documents.

- **Files:** `src/ui/fly/orientation-binding.ts` (+ node test) — the pure
  decision half (bind/effect: none|invalidate|restore) plus the injectable
  matchMedia seam types; `fly-session.svelte.ts`/`fly-session.ts` wiring
  (bound at capture start, released on capture stop/death, change listener
  removed in destroy()); FlyFlow banner + armDisabled, FlySetupPanel test-mode
  gate; `capture-session.ts`/`.svelte.ts` gained `resetBackground()` (forwards
  to the pipeline); `fly-orientation.browser.test.ts` (Chromium-gated, fake
  matchMedia + quiet captureStream scene); `src/core/precache.test.ts` +
  `test:precache` script + a post-`check` ci.yml step;
  `docs/runbooks/{device-matrix-checklist,field-acceptance,deploy,
  on-device-debugging}.md`; detection.md Orientation section now states the
  enforced behavior (annotation removed); testing.md unit-section one-liner.
- **Invalidation mechanism (judged as directed):** on mismatch the crossing
  detector is DETACHED via the existing attach/detach helper — NOT
  `setPipelinePause(true)`, which freezes the EMA deliberately and would
  dishonestly imply detection continues. Crossings during the mismatch are
  lost (the spec's "invalidate until restored"); an armed session stays armed
  and timing continues (page-hidden precedent). On restore:
  `capture.resetBackground()` (the EMA absorbed rotated frames while
  detached), then `attachDetection()` for test/armed — the freshly built
  detector IS the reset across the gap — and while armed the existing
  interruption notice is raised ("laps during the gap were not detected", the
  page-hidden banner reused verbatim).
- **Decisions/assumptions:**
  - Binding lives in **fly-session, not capture-session**: it is fly-flow
    product behavior; `/lab` must keep working rotated (its panels are
    instruments, not a bound session). `/lab` gets nothing — the plan's item
    was product scope.
  - Bound at **capture start** (the setup step's camera start), not at mount
    or arm: no ROI is in use before the camera runs, and detection.md's
    "captured at setup" is the camera-running calibration state. Stop/death
    releases; restart rebinds to the current orientation (pinned in the
    browser test).
  - Arm and test mode are **refused while mismatched** (session-level guards
    + disabled buttons): attaching a detector to rotated frames is never
    valid, not just while armed.
  - `injectCrossing` (test seam) drops events while mismatched, mirroring the
    detached detector — otherwise the browser test could not observe the
    invalidation the way production exhibits it.
  - The warning renders once in FlyFlow (above every camera-active phase's
    panel, `role="alert"`, enlarged) rather than per-panel — covers setup
    (calibration is orientation-bound too), test, and armed.
  - Orientation source: `matchMedia('(orientation: portrait)')` behind an
    injectable `OrientationMatchMedia` seam (display-mode.ts precedent);
    listener registered at session creation and removed in destroy()
    (visibilitychange precedent — fly-session owns its lifecycle, no $effect).
- **Precache/CI wiring:** `src/core/precache.test.ts` parses the Workbox
  manifest out of `dist/sw.js` (regex harvest — the literal has unquoted
  keys) and asserts index.html, ≥1 `.js`, ≥1 `.css`, ≥1 `.cwclip` (the /lab
  self-test clip), manifest.webmanifest, and all three icons.
  `describe.skipIf` skips it when `dist/sw.js` is absent (plain `bun run
  test` runs pre-build); CI gates it via a dedicated `bun run test:precache`
  step AFTER `bun run check` (which ends with the build) in the existing
  check job — judged over reordering `check` itself (build-last keeps the
  fast-feedback order locally).
- **Runbooks (items 10, 11, 12):** device-matrix-checklist.md (12-item
  checkbox table × Android Chrome gating / desktop Chromium gating / iOS
  best-effort-blocked-by-MSTP; post-ADR-0009 — no GPU rows; /diag row doubles
  as the still-owed ADR 0008 S22 transcription reminder); field-acceptance.md
  (N ≥ 3 sessions, stopwatch + frame-stepped video ground truth, ±1 frame of
  the delivered rate ≈ ±17–33 ms with the video's own reading error summed,
  cross-device export→import round trip, per-session record table, /lab
  fixture-harvesting workflow); deploy.md (CI deploy-on-main + secrets,
  manual `bun run deploy`, `wrangler rollback` incl. the schemaVersion
  caveat, SW build-id + update-prompt flow); on-device-debugging.md
  (chrome://inspect, /diag + /lab tours, field fixture capture, OPFS console
  snippets — no native DevTools OPFS browser — single-writer Web Lock
  warning, `.corrupt.<ts>` recovery via envelope-wrapped re-import as the
  validated path).
- **Verify:** typecheck, lint, unit 832 (incl. the ran-not-skipped precache
  test against the stale local dist), browser (chromium) 85/85, build green.

## Wave C — E2E + desktop layout

Item 8 (E2E round trip, adapted) and item 6 (desktop layout pass).

- **Files:** `src/ui/e2e.browser.test.ts` (new); `App.svelte` (fly-route test
  seams + breakpoint comment), `FlyFlow.svelte` (stopped-phase nav polish),
  `Home.svelte`/`CourseView.svelte`/`SessionView.svelte` (desktop media
  queries; CourseView/SessionView gained a `.review-columns` wrapper div).
- **E2E adaptation (the standing deviation, per the orchestrator decision):**
  the vitest browser rig IS the E2E harness — Playwright proper was
  deliberately not introduced. One Chromium-gated continuous test (gated on
  MediaStreamTrackProcessor, same as the fly suite) drives the REAL App:
  phone leg (MemoryStorage A): mount at #/ → create the course through the
  form (name typed, ltr/3 s defaults) → Fly → Start camera (quiet
  canvas.captureStream scene behind the mediaDevices seam) → Arm → 3 injected
  crossings = clock start + laps 14.32/13.33 exactly → Discard last →
  Stop → stopped table pinned (2 rows, exact durations, discarded struck,
  best on 14.32, no 3-window, backup nudge shown) → Course link → all-time
  records + session row pinned (their normalized text captured) → Home →
  Export with `navigator.canShare/share` patched to capture the delivered
  File → blob text parsed and asserted exactly (schemaVersion, course
  identity, lap `[durationMs, status]` pairs) → lastExportAt recorded.
  Desktop leg (fresh App over fresh MemoryStorage B): import the captured
  text via the Home file input → "Added 1 course and 1 session; skipped 0/0"
  → course view records + session row byte-identical to the phone leg's
  captured text → session view lap table identical → re-import is an all-skip
  no-op (idempotence pinned end-to-end).
- **App test seams:** App.svelte gained optional `mediaDevices`/`onsession`
  props forwarded to the fly route — the same seams Fly.svelte already
  exposed; the real page passes neither. Judged over patching
  navigator.mediaDevices (the fly-suite precedent is seam injection).
- **Polish fix (found by walking the loop):** after Stop the fly screen had
  NO navigation affordance (header nav was setup-only; only browser back
  escaped). The Course/Home header links now render in the stopped phase
  too; mid-flight phases still hide them on purpose (leaving stays
  deliberate). The E2E navigates through the new link.
- **Desktop layout (item 6):** breakpoint 48rem (≈768px), documented at the
  `:global(main)` rule in App.svelte; custom properties can't parametrize
  media queries, so each review screen repeats the literal in its own
  `@media (min-width: 48rem)` block. Phone-first CSS untouched below it.
  - Home: main widens to 56rem, course list becomes a 2-column grid
    (46rem cap).
  - CourseView: main 64rem; all-time records sit beside the session list
    (`.review-columns` grid, records column minmax(16–20rem), sessions capped
    at 44rem); Edit link pinned next to the title instead of stranded by
    space-between at full width.
  - SessionView: main 64rem; records + note beside the lap table
    (info column minmax(18–24rem), table column capped 44rem — "lap tables
    comfortable width").
  - CourseForm already caps its form at 24rem (constrained everywhere);
    fly flow deliberately unchanged (phone-beside-the-gate flow).
  - Verified visually against the real build (vite preview + import of a
    seeded export, screenshots at 1280px and 390px); phone rendering
    unchanged, all pre-existing browser tests green.
- **Verify:** typecheck, lint, unit 832, browser (chromium) 86/86, build all
  green.

## Item dispositions — plan items 4 and 7 remainders

The parts of items 4 and 7 not already logged in a wave above:

- **Update-prompt UX polish (item 4):** judged **not needed**. The Phase 1
  skeleton already meets the spec in full — visible build id, "Update
  available" banner, one-tap update-and-reload (`UpdateBanner.svelte`,
  `registerType: 'prompt'`) — and it has been exercised by every deploy since.
  There is nothing concrete to polish without field feedback; revisit if the
  device-matrix or field sessions surface a real friction.
- **Camera revoked mid-app + wake-lock loss surfacing (item 7):** already
  shipped — armed camera/track death auto-stops the session with laps retained
  and a prominent failure notice (Phase 5), wake-lock loss is surfaced in the
  UI (Phase 5), storage failures and read-only state surface on the product
  screens (Phase 6). Verified rows exist in the device-matrix checklist
  (items 6–8); no Phase 7 code was needed.
- **Speech-unavailable degradation (item 7's "visual-only lap display with
  warning"):** **moot by design.** Speech synthesis is a hard capability-gate
  requirement (product.md Platform requirements; `capabilities.ts` probes it
  at startup) — a browser without speech never reaches the timer, it gets the
  unsupported screen. A degraded speechless timer mode would contradict the
  gate; not built.
- Item 7's orientation binding: delivered in Wave B2 (above). Items 4's
  automated halves: precache test + manual airplane item, per the
  pre-implementation deviation note.

## Verification status (v1 close)

The honest ledger of what is verified by machine and what a human still owes.

**CI-verified (green at close, 2026-07-13):**

- Unit (node): 66 files, **835 tests** — core services, detection pipeline,
  determinism/goldens, corpus harness, full-loop + never-block storage
  variants, storage schema/contract (memory + fake-OPFS rigs), import
  fuzz/property suite, backup nudge, orientation binding.
- Browser-contract (Chromium, gating): 14 files, **86 tests** — real-OPFS
  contract/crash/quarantine suites, product-screen component tests,
  portability/nudge/orientation suites, and the two-leg E2E round trip
  (`e2e.browser.test.ts`). WebKit leg informational per ADR 0006.
- Precache completeness: **1 test** (`test:precache`) against the built
  `dist/sw.js`; CI runs it after the build.
- typecheck, lint, build: green (`bun run check`).

**Owed manual items (not CI-verifiable; the v1 sign-off checklist):**

1. **Airplane-mode installed-PWA session** on the S22 — install, go offline,
   relaunch from the icon, full timing session (device-matrix row 11). The
   automated offline story covers precache completeness only; the offline
   *reload* has never been machine-tested.
2. **Device-matrix checklist execution** (`docs/runbooks/device-matrix-checklist.md`)
   on Android Chrome (S22) + desktop Chromium; iOS best-effort rows when a
   device exists.
3. **Field acceptance protocol** (`docs/runbooks/field-acceptance.md`) —
   N ≥ 3 real flight sessions against stopwatch + frame-stepped video; closes
   the ±1-frame claim.
4. **ADR 0008 S22 transcription** — the /diag numbers row of the device
   matrix doubles as the reminder to transcribe the S22 probe results into
   ADR 0008 (still owed since Phase 2).
5. **Real tab-kill durability check** — CI proves the persistence contract
   over simulated crashes; an actual task-switcher kill mid-session on the
   phone (device-matrix row 12) has not been performed.

Item 9 (real-world tuning pass) remains a rolling field item per the
pre-implementation decision, not a v1 gate.

## Review fixes — import tests + storage.md (2026-07-13)

All five assigned findings judged valid and applied; none disputed.

- **test-rigor#1 (importIntoStorage untested):** `import.test.ts` gained an
  `importIntoStorage` block over a recording/failing structural ImportTarget:
  (a) the exact write order is pinned (`saveCourses` lands before the first
  `saveSession`); (b) `saveSession` fails on call 2 of 3 → the injected
  'write-failed' StorageError propagates, only pre-failure items landed, and
  re-importing the same envelope into the same target completes the merge
  with correct final state, correct skip counts, and NO second saveCourses
  (idempotent recovery pinned end-to-end); (c) an all-existing (zero-add)
  import performs no writes at all.
- **test-rigor#5 (precache skip reads green in CI):** `precache.test.ts` now
  fails instead of skips when `PRECACHE_REQUIRED=1` is set and `dist/sw.js`
  is absent; ci.yml's `test:precache` step sets that env. Local behavior
  unchanged (plain `bun run test` still skips pre-build).
- **architect#2 (in-tab settings race):** documented in the importAll
  contract comment (storage.ts) and the storage.md settings bullet — the
  import's course write-back re-persists the settings read at import start,
  so a concurrent fire-and-forget settings write (e.g. lastExportAt) can be
  reverted; accepted, costs at most one extra backup nudge.
- **architect#3 (unsupported-version overwrite edge):** the Wave A known
  limitation is now in storage.md's import bullet, not just these notes.
- **docs#2, storage.md half (orphan sessions overstated):** spec softened to
  the honest behavior — orphans are retained, export, and render with an
  "unknown course" placeholder when opened, but v1 lists them under no
  course. Known limitation: an orphan session is reachable only by direct
  `#/sessions/<id>` link (or a later import of its course); nothing in the
  v1 UI enumerates orphans.
- **Verify:** typecheck, lint, unit (835, incl. the 3 new import tests) all
  green; `bun run build && PRECACHE_REQUIRED=1 bun run test:precache` runs
  the precache check for real, and the required-but-missing-dist path was
  proven to fail with the run-build-first message before restoring dist.

## Review fixes — docs sweep (2026-07-13)

All seven assigned findings judged valid against the code and applied; none
disputed.

- **docs#1 (.corrupt recovery envelope missing `settings`):** verified against
  `parseExportEnvelope` (schema.ts — `objectField(obj, 'settings', '$')`
  throws when absent, and `parseSettings` requires `speechEnabled`).
  on-device-debugging.md step 4's recipe now includes
  `"settings": { "speechEnabled": true }` with a note that the field is
  required by the parser but inert on import (local settings always win).
- **docs#3 (roadmap Phase 7 deviations unannotated):** 00-roadmap.md — the
  Phase 7 table row notes device-matrix + field acceptance as documents
  committed / execution pending, and the Phase 7 exit-criteria line annotates
  "Playwright E2E" as delivered via the vitest browser-mode E2E + node
  precache test (no standalone Playwright; offline reload is the manual
  airplane item), the airplane-mode session as a pending manual item, and the
  sign-offs as pending field execution. Annotated inline, Phase 6 style; no
  rewrite.
- **docs#4 (testing.md stale at Phase 6):** status paragraph now reads
  "Phase 7 / v1" and walks all seven phases' suites; Browser-contract lists
  the Phase 7 additions (portability, deliver-export, backup-nudge,
  fly-orientation) plus `e2e.browser.test.ts` with the two-leg round trip
  described; Unit describes the import fuzz/property suite; Manual links the
  two committed runbooks instead of "a written checklist".
- **docs#5 (items 4/7 disposition):** "Item dispositions" section added above
  — update-prompt polish not needed, camera-revoked/wake-lock surfacing
  shipped Phases 5–6, speech degradation moot behind the capability gate.
- **docs#6 (field-acceptance.md called Record a ring):** verified against
  `ContinuousRecorder` (recorder.ts — at the 1800-frame cap `add()` drops new
  frames and counts them; the OLDEST frames are kept and the clip is marked
  truncated). The harvesting step now says Record keeps the first ~30 s and
  Snapshot ring is the after-the-event tool.
- **docs#7 (iOS footnote conflated /lab with product flow):** device-matrix
  footnote split — `*` (row 2): `/lab` is gate-exempt and the self-test is
  pure TS with no MSTP, so it genuinely runs on iOS and is the only runnable
  numeric check there; `†` (row 11): product flow, expected blocked by MSTP.
  Device row C's description mentions the runnable self-test too.
- **docs#8 (product.md armed-interruption misses orientation):** one sentence
  added cross-referencing the orientation-mismatch case (invalidated until
  restored, same interruption notice — see detection.md, Orientation).
- **Verification-status ledger:** section added above with measured counts
  (unit 835, browser Chromium 86, precache 1, all green on this tree) and the
  five owed manual items.
- **Verify:** re-read every touched file for consistency; `bun run test`,
  `bun run test:browser`, `bun run test:precache` all green; lint untouched by
  these doc-only edits.

## Review fixes — UI + orientation pins (2026-07-13)

Phase 7 review findings owned by the UI fixer; all applied, verified with
`typecheck && lint && test (838) && test:browser (88) && build` green.

- **test-rigor#2 (Medium) — orientation invalidation execution now pinned.**
  Chose the seam route over the loud-scene route (driving a real optical
  crossing deterministically stays out of CI, per the standing decision).
  `FlySession` gained a documented test seam `detectionAttached` (reads
  `detachDetection !== null` — the real attach state, not the injectCrossing
  guard); the armed orientation browser test now asserts attached → mismatch
  detaches (real detach) → restore re-attaches, and pins the restore ORDER by
  spying `DetectionPipeline.prototype.resetBackground` (the real pipeline
  method — no product seam needed) and recording `detectionAttached` at call
  time (must be false: background reset happens before re-attach). Mutation
  re-runs, each against the snapshot-then-byte-verified-reverted file: delete
  detach-on-invalidate → 2 tests fail (`expected true to be false`); delete
  resetBackground-on-restore → fails (`resetBackground called 0 times`);
  delete attachDetection-on-restore → fails (`expected false to be true`).
  All three killed.
- **test-rigor#3 (Low) — detach-un-pause test made real.** The trivially-true
  post-detach `pauseCalls.at(-1) === false` (already false before detach after
  a full pump) was removed from the first test; a dedicated test pumps only
  the pre-crossing half of a wave (detector mid-candidate, last pause call
  true), detaches, and asserts the last pause call flipped false.
- **TS#1 (Low) — Home import refreshes moved to `finally`.** A mid-import
  failure can land partial writes; both repo refreshes now run regardless of
  outcome (they never reject — repo failures land in lastError).
- **TS#2 (Low) — read-only export no longer pollutes lastError.** Judged the
  skip over silent-failure routing: `runExport` skips the lastExportAt
  recording when the storage is structurally read-only — the write was doomed
  and would surface "Storage error" above the success notice. The (not
  exported) `storageReadOnly` helper moved from storage-context.svelte.ts to
  storage-context.ts (plain TS, now exported) so export-action stays
  node-testable. Nudge keeps firing in a read-only tab — honest, nothing was
  recorded. Pinned in portability.browser.test.ts (readOnly-marked
  MemoryStorage: export succeeds, lastExportAt stays unset).
- **TS#3 (Low) — stop while rotated keeps the gap visible.** `stopSession`
  raises the interruption notice when `orientationMismatch` is still true at
  stop (the restore path, the usual raiser, never ran). A mismatch while armed
  always means a detached-detector gap: arming is refused while mismatched, so
  the rotation happened after arm. New browser test: arm → rotate → Stop →
  stopped panel shows the notice, warning gone.
- **architect#1 (Low) — install listener registration declared at startup.**
  pwa-install.svelte.ts exports idempotent `initPwaInstall()` (App mounts more
  than once across a browser-test file); App.svelte calls it at mount instead
  of relying on Home's import graph surviving future code splitting.
- **architect#4 + simplicity#1 — FlyStoppedPanel `context` now required.**
  The optionality was only for the parallel wave's direct mounts; the direct
  mounts (backup-nudge.browser.test.ts) already pass a context. Guards
  deleted.
- **simplicity#2 (Low) — export notice copy deduplicated.**
  `exportOutcomeNotice(outcome)` in export-action.ts owns the outcome→text
  mapping (null for 'cancelled'); Home and FlyStoppedPanel keep only their own
  `$state`.
- **test-rigor#4 (Low) — runExport failure branch tested.** New node test
  export-action.test.ts: storage whose exportAll rejects → `{kind:'failed'}`,
  updateSettings untouched, and the notice mapping for all three outcomes.
