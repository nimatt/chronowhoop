# Staging notes — implement docs/plans/06-persistence-product-ui.md

Autonomous /implement-plan run (user pre-consented), post-ADR-0009. Started 2026-07-13
at `1fc7fe1` (Phase 5 committed).

## Pre-implementation

### Orchestrator decisions (declared before dispatch)

- **One global schemaVersion** shared by courses.json, session files, and the export
  envelope (plan item 1's recommendation). Export envelope:
  `{ schemaVersion, exportedAt, courses, settings?, sessions }`.
- **App-level settings** (stored in courses.json per storage.md):
  `{ lastExportAt?: IsoDateString; speechEnabled: boolean (default true);
  lastCourseId?: string }` — the minimal set the plan recommends.
- **Multi-tab policy:** Web Locks single-writer; a second tab gets read-only mode with
  a "session active in another tab" notice.
- **Session file created at arm time** (a zero-lap crash leaves a recoverable record).
- **Atomic write mechanism:** `createWritable()` swap-file commit-on-close, recorded as
  ADR 0010 citing Chromium semantics + the real-browser crash tests; the on-device S22
  citation is owed (OPFS /diag probes not yet run on the phone — ADR 0008).
- **Quarantine:** OPFS has no rename — "rename aside" = write the corrupt bytes to
  `<name>.corrupt.<ts>` then remove the original; warn and continue.
- **Routing gains params** (the ADR 0007 revisit moment): hand-rolled parser extends to
  `#/course/<id>`, `#/session/<id>`, `#/fly/<courseId>`; no router library.
- **Prefill:** new sessions seed detectionConfig from the course's most recent
  session's snapshot, else defaults (product.md).
- **Skipped:** iOS install-before-data banner (ADR 0006/0008 — no device; export is
  the migration path). Desktop layout pass stays in Phase 7 per the plan.

### Wave plan

A: schema contract + Storage interface + MemoryStorage + contract suite + ADR 0010 +
storage.md updates → B: OpfsStorage (+ crash tests) ∥ C: live-session write path +
never-block test + exportAll → D1: routing params + repositories + home/course CRUD →
D2: course-backed fly + session/course views. Mid-phase checkpoint after C/D2 wiring:
tab-kill mid-session loses at most the last lap.

## Phase logs

(appended by implementer subagents below)

## Wave A — schema + storage interface (2026-07-13)

Items 1–3: `src/core/storage/{schema,storage,memory-storage,storage-contract}.ts`
(+ tests), ADR 0010, storage.md amendments. Decisions/assumptions:

- **SessionSummary fields:** `{ id, courseId, startedAt, lapCount, validLapCount }` —
  what the course view's session list needs without loading lap bodies; records stay
  derived from full sessions, never from summaries.
- **Ordering + tie-break:** one shared comparator (`compareSessionRecency`, exported
  from storage.ts so implementations cannot disagree): startedAt as epoch ms, ties
  broken by id code-unit order with the larger id newer (arbitrary but deterministic;
  ids are random UUIDs). `listSessions` returns newest first;
  `latestSessionForCourse` is the max; `exportAll` sessions are oldest first. All
  three pinned by the contract suite.
- **`loadCourses` never rejects with not-found:** empty storage yields
  `{ courses: [], settings: defaultAppSettings() }` — every caller would handle the
  miss identically, so the interface absorbs it. `loadSession` DOES reject
  (StorageError 'not-found').
- **Validator strictness:** strict on required fields/types; ranges only where
  semantics demand: durations/minLapTimeMs ≥ 0, lap.n and stripCount integer ≥ 1,
  all tunables/detector numbers finite, date strings must `Date.parse` (ordering
  depends on it). No business rules (lap sequence, ROI ∈ [0,1] etc. unchecked).
  Unknown extra keys tolerated but NOT preserved — parse results are freshly built
  known-field objects; any additive change bumps the global schemaVersion, so
  nothing a current app should keep is dropped.
- **`speechEnabled` is required in stored settings** (writers always write it; the
  default applies only to empty storage and the v0→v1 migration). Optional fields
  absent-or-string, `null` rejected.
- **Migration registry:** keyed by from-version, `(doc, kind) => doc` with
  kind ∈ courses|session|export (one global version, three file kinds); the DRIVER
  stamps `schemaVersion: v+1` after each step so migrations only transform shape.
  Documents newer than SCHEMA_VERSION are refused with a SchemaError. The shipped
  0→1 entry is the synthetic mechanism proof (v0 never shipped; fabricated
  difference: "v0 lacked settings").
- **Error taxonomy:** single `StorageError` class with
  `kind: 'not-found' | 'corrupt' | 'quota-exceeded' | 'write-failed'` + optional
  cause; guards `isStorageError` + one per kind. `importAll` stubs reject with a
  plain `Error` — calling it before Phase 7 is a programming error, not a storage
  failure.
- **`persistenceStatus` is minimal:** `{ persisted: boolean }`; MemoryStorage
  reports true. Quota/usage stay on the /diag probe until a real consumer exists.
- **Interface is named `Storage`** (per plan) — shadows DOM `Storage`; it must be
  imported, never picked up from lib.dom.
- **MemoryStorage deep-copies via `structuredClone`** on save and load; injectable
  `now: () => IsoDateString` for exportedAt. Contract suite checks exportedAt is
  within the test's real-time bounds, so factories must return real-clock instances.
- **Contract suite** (`storage-contract.ts`) imports vitest but is not itself a test
  file (unit project only collects `*.test.ts`); it uses no node-only APIs so the
  OpfsStorage wave can run it from a `.browser.test.ts`. It pins the importAll
  Phase 6 stub — Phase 7 flips that case to real merge semantics.
- **storage.md session example** detector block expanded from `…` to the full
  frozen CrossingDetectorConfig field set (matches types.test.ts); no drift found
  in the tunables.

## Wave B — OpfsStorage (2026-07-13)

Item 4: `src/core/storage/opfs-storage.ts` (+ node unit tests with a nested
fake OPFS in `opfs-storage.test.ts`, + `opfs-storage.browser.test.ts` running
the real contract suite, crash-simulation, quarantine round-trip, and real
Web Locks tests in Chromium). Extended `OpfsDirectoryLike` (opfs-probe.ts)
with optional `getDirectoryHandle` and `removeEntry` recursive option.
Decisions/assumptions:

- **Constructor:** `new OpfsStorage(options?)` with
  `{ storage?: OpfsStorageLike; locks?: LocksLike; rootDirectory?: () =>
  Promise<OpfsDirectoryLike>; now?: () => IsoDateString; onQuarantine?:
  (event: QuarantineEvent) => void }` — all optional; production is
  `new OpfsStorage()` (navigator.storage + navigator.locks + OPFS root + real
  clock). `storage`/`locks` are presence-checked (`'locks' in options`), so
  passing the key explicitly as `undefined` models an absent API.
  Extras beyond the Storage interface: `get readOnly(): boolean`,
  `requestPersist(): Promise<boolean>`, `dispose()` (releases the writer
  lock; test-facing — product holds it for the page lifetime).
- **Startup sweep does nothing and was not built** (ADR 0010 amendment):
  honest inventory found no artifacts of our own to sweep. All writes go
  through `createWritable()`; its `.crswap` staging files are browser-managed
  and deleting one could race another tab's in-flight write; `.corrupt.<ts>`
  quarantine files are kept deliberately; reads skip every non-`.json` name,
  so stale artifacts cannot shadow real files.
- **Web Locks:** `chronowhoop-storage` lock requested `{ ifAvailable: true }`
  in the constructor, held via a never-resolving callback promise until
  `dispose()`. Not granted → read-only: writes reject StorageError
  'write-failed' "read-only: another tab holds the lock" (writes await the
  grant internally, so the pending answer can't be raced); `readOnly` is
  false until the request resolves. Absent/failing locks API → proceed as
  writer. Dispose-before-grant is handled (the callback releases immediately)
  — the browser rig hit that leak: a reads-only test's dispose ran before the
  lock callback, stranding the lock for every later instance.
- **Quarantine** (JSON.parse failure or SchemaError): copy raw bytes to
  `<name>.corrupt.<ts>` (ts = injected clock, non-filename-safe chars → `-`),
  then remove the original; if the copy itself fails, the original stays (never
  destroy the only copy; next read retries). Read-only instances skip the file
  ops entirely (no write lock) and only report. `onQuarantine` fires either
  way; `quarantinedTo` is absent when no copy was made. loadCourses → defaults,
  loadSession → 'not-found', list/export → skip and continue (any per-file
  read failure is also skipped there, quarantined or not).
- **listSessions collects names before reading** — quarantine mutates the
  directory, which must not happen under a live directory iterator.
- **Error mapping:** writes — `QuotaExceededError` (by `error.name`) →
  'quota-exceeded', else 'write-failed'; failed writes best-effort `abort()`
  (never-closed is already safe per ADR 0010). Read-side infra failures (not
  missing, not parse/schema) → 'corrupt' with cause — the taxonomy's only
  read-failure kind. Unusable backend (no getDirectory / root open fails /
  no getDirectoryHandle) → 'write-failed'.
- **persist():** requested lazily once per instance after the first
  *successful* saveCourses/saveSession, fire-and-forget; the answer surfaces
  through `persistenceStatus()` (live `persisted()`, false when the API is
  absent or throws). Public `requestPersist()` exists for Wave D.
- **Browser-test isolation:** every instance is rooted (via `rootDirectory`)
  in a throwaway `chronowhoop-opfs-storage-test-<uuid>` subdir of the real
  OPFS root, removed recursively in cleanup; the Web Lock is origin-global,
  so cleanup also disposes. Crash tests: abort mid-rewrite → original intact;
  partial write never closed → committed content still read (writable aborted
  only in cleanup, after assertions); on-disk corruption → not-found +
  `.corrupt.<ts>` byte-identical copy + listing survives; real-Web-Locks
  second instance → read-only.
- Node unit tests run the full contract suite against the fake OPFS too, so
  the fake and the real rig pin identical semantics.

## Wave C — write path + export (2026-07-13)

Item 5 + item 6's logic half: `src/core/session/session-persister.ts` (+ test),
`src/core/full-loop-rig.ts` (rig extracted from full-loop.test.ts, assertions
unchanged), `src/core/full-loop-storage.test.ts` (the never-block proof),
`src/core/storage/export.ts` (+ test). Decisions/assumptions:

- **SessionPersister API** (Wave D wires into the fly screen):
  `createSessionPersister(storage, { retryDelaysMs?, scheduleFn?, cancelFn?,
  onStateChange? })` → `{ sessionStarted(session), sessionUpdated(session),
  flush(): Promise<void>, state }`. sessionStarted at arm (file exists before
  the first crossing), sessionUpdated on every lap AND every discard, flush
  after Stop. All entry points synchronous fire-and-forget; nothing ever throws
  into the caller (a non-StorageError from an implementation is coerced to a
  retriable 'write-failed').
- **State shape:** `{ pending, retryScheduled, lastError?: { kind, message },
  savedLapCount? }`. `savedLapCount` is the "saved through" indicator — the lap
  count of the last successfully written snapshot (honest but deliberately
  blind to discard flags, which ride in the same snapshot; `pending: false`
  plus no error means the latest snapshot, discards included, is on disk).
- **Coalescing is global, not per session id:** single-flight, the newest
  snapshot replaces any queued or retry-pending one (every snapshot is the
  full session, so newest supersedes). One persister serves one session at a
  time; Wave D should flush (or accept losing the old session's queued tail)
  before re-arming. sessionStarted resets lastError/savedLapCount.
- **Retry policy:** backoff [500, 2000, 5000] ms on 'write-failed' only; every
  other kind (quota-exceeded, corrupt, not-found) surfaces immediately with no
  retry. A NEW snapshot cancels a scheduled retry and saves immediately with a
  fresh attempt budget (retrying stale data when newer data exists is never
  right). A failure while a newer snapshot is queued skips retry and sends the
  newer snapshot.
- **flush() semantics:** resolves at quiescence (no in-flight, queued, or
  retry-pending save); never rejects — callers read `state` after. It promotes
  a scheduled retry to run immediately and keeps subsequent write-failed
  retries back-to-back (no wall-clock backoff while the user waits at Stop)
  until success or the attempt budget is spent. Against a storage whose save
  never settles, flush never resolves — the UI must treat `state.pending`
  as the unsaved-laps signal, not wait unconditionally.
- **Never-block proof structure** (full-loop-storage.test.ts): the canonical
  clip scenario (extracted to full-loop-rig.ts as `runCanonicalClip` +
  `createArmedSessionRig`, now with an `onLap` hook invoked BEFORE the
  announcement — exactly where the fly screen calls the persister) runs four
  ways: no storage, MemoryStorage+persister, hang-forever storage, and
  fail-every-write storage. The full `RunOutcome` (crossing events, armed
  start, per-lap arrival records, announcement decision log, spoken-so-far,
  final statuses after discard) is compared via JSON.stringify — literally
  byte-identical — and the scenario body is fully synchronous, so no run can
  have awaited storage. The MemoryStorage run additionally flushes and asserts
  the stored session equals the engine's final session (discard included) —
  discard-as-window-break end-to-end.
- **Export helpers** (`export.ts`): `buildExportFilename(now: Date)` →
  `chronowhoop-export-YYYYMMDD-HHMM.json` in LOCAL time;
  `exportAllToBlob(storage)` → `{ blob, filename }` with pretty-printed
  (2-space) `application/json` — backups should be human-inspectable and the
  data is small text. The filename timestamp derives from the envelope's own
  `exportedAt`, so name and content always agree. The helper updates
  `settings.lastExportAt` (= exportedAt) via loadCourses/saveCourses right
  after assembly — the Phase 7 backup-nudge seam — and swallows a failure
  there: the export must still reach the user; a stale lastExportAt only
  costs an extra nudge. The envelope snapshot is taken BEFORE the update, so
  an export records the PREVIOUS lastExportAt (pinned by test). Browser
  delivery (anchor click / share sheet) stays UI-side; Wave D reuses the
  src/ui/lab/download.ts pattern with this blob + filename.

## Wave D1 — routing + repos + course CRUD (2026-07-13)

Items 7 + 8 + the routing prerequisite: `src/core/routing/route.ts` (Route
union + `hashFor`, ADR 0007 amended), `src/ui/data/{repos.ts,
storage-context.ts, storage-context.svelte.ts}` (+ repos.test.ts),
Home rework + `CourseForm.svelte` + `CourseView.svelte` shell,
`course-crud.browser.test.ts`. Decisions/assumptions:

- **Route is a discriminated union** replacing the string RouteId:
  `home | diag | lab | fly(courseId) | course(courseId) | session(sessionId)
  | new-course | edit-course(courseId)`. Parser rules: ids are opaque
  non-empty segments (no decoding — they are UUIDs); any empty segment,
  trailing junk, or unknown first segment → home; `new` is reserved by
  `#/course/new` (`#/course/new/edit` → home). `hashFor(route)` is the single
  source of hash strings — navigation is `location.hash = hashFor(route)`,
  links are `href={hashFor(...)}`; no separate navigate() helper.
- **Fly bridge (pending D2):** `#/fly/<courseId>` parses and App renders Fly
  with `courseId` as a prop that Fly accepts and deliberately ignores
  (documented in the component); plain `#/fly` no longer exists. `#/session/
  <id>` parses but renders Home until D2 ships the session view — no D1
  screen links to it, so there is no broken-link window.
- **Repos are plain-TS classes** (`src/ui/data/repos.ts`, the plan's PREFER
  option): CoursesRepo/SessionsRepo own snapshots, upsert semantics, and
  error mapping, node-tested against MemoryStorage.
  `storage-context.svelte.ts` mirrors each repo's snapshot into `$state` on
  the repo's `onChange` — the same core-truth → reactive-mirror bridge
  fly-session uses for laps; all low-frequency, per the bridge rule.
- **Repos never throw into the UI:** every failure lands in
  `lastError: { kind: StorageErrorKind | 'unknown', message }`; ops report
  success through return values (saveCourse/updateSettings → boolean,
  createCourse → Course | null, loadSession/latestForCourse → Session |
  undefined). `ensureLoaded()` is load-once with shared concurrent calls; a
  FAILED load is not cached, the next call retries. `reload()`/`refresh()`
  are the invalidation points. Saves are non-optimistic: on failure the
  in-memory snapshot stays at the last known-good state.
- **updateSettings:** an explicitly-`undefined` value removes the key (so
  optional settings can be cleared); otherwise shallow merge.
- **StorageContext** is created once per App.svelte mount and passed to
  screens via props (diag/fly precedent). Injection seam:
  `createStorage?: (onQuarantine) => Storage` — the callback is handed in so
  quarantining implementations report into the context; default
  `new OpfsStorage({ onQuarantine })`. `destroy()` (App unmount) disposes
  OpfsStorage to release the writer lock — page lifetime in production,
  matters for test remounts.
- **readOnly / persistence are polled, not pushed:** both underlying answers
  (Web Locks grant, `persist()`) settle asynchronously, so the context
  re-reads them once at creation and after every repository operation
  settles. Worst case a just-flipped read-only state appears one interaction
  late. `readOnly` is false for storages without the concept (instanceof
  OpfsStorage check).
- **Quarantine notices render app-level in App.svelte** (dismissable panel
  above the routed screen), so they surface on any screen, not just Home.
  Home shows the read-only banner and a small persistence warning when
  `persisted` is false.
- **lastCourseId is NOT touched by course create/edit** — the plan's prefill
  convenience is about the most recently *flown* course; D2 sets it when
  flying.
- **CourseForm cancel** navigates to explicit targets (home for new, course
  view for edit) instead of history.back() — deterministic under deep links
  and in tests. The form seeds its fields once per mount (edit waits for the
  load); App `{#key}`s the edit route on courseId so edit-A → edit-B
  remounts. Min lap is entered in seconds (default 3.0, ≥ 0, step 0.1) and
  stored as `Math.round(seconds * 1000)` ms.
- **app-gate.browser.test.ts now injects MemoryStorage** — App always creates
  a storage context, and the gate tests should not touch the real OPFS root
  or the origin-global writer lock.
- **CourseView is the D1 shell only** (header, Edit link, Fly button, empty
  sessions area); sessionsRepo is unused by any D1 screen but built and
  node-tested for D2.

## Wave D2 — persisted fly + views (2026-07-13)

Items 5 (UI wiring) + 6 (delivery) + 9 + 10 + 11: Fly.svelte rebuilt as a
loader + new `src/ui/fly/FlyFlow.svelte`, fly-session rewired to Course +
SessionPersister, `src/ui/screens/SessionView.svelte`, CourseView completed,
export button on Home, `downloadBlob` moved to `src/ui/shared/download.ts`.
Decisions/assumptions:

- **Fly.svelte is now a pure loader** for `#/fly/<courseId>` (App keys it on
  courseId): it resolves the Course from coursesRepo AND the prefill
  (`latestForCourse(courseId)?.detectionConfig`, else defaults per product.md)
  BEFORE mounting FlyFlow, so `createFlySession` takes a real `Course`
  synchronously. Missing course → notice + home link. quick-course.ts is
  deleted — the flow is course-backed only, no ephemeral fallback (`wallClock`
  moved to fly-session.ts).
- **Prefill application:** the snapshot's tunables seed the capture session
  before the camera starts (setRoi + updateTunables); the snapshot's detector
  block seeds every detector the flow creates, EXCEPT triggerLevel, which
  always derives from the live tunables slider (they'd otherwise disagree the
  moment the slider moves). A stored detector block that fails the detector's
  own range validation (schema only checks finiteness) falls back to detector
  defaults instead of throwing out of Arm.
- **Setup step:** the inline direction/min-lap inputs are REMOVED (the course
  owns them per product.md concepts); shown read-only with an "Edit course"
  link. Consistent with the spec's setup step: "user picks a course", then
  positions camera/ROI/sensitivity — course fields are not setup-time inputs.
- **Persister wiring lives inside fly-session** (`storage` option; FlyFlow
  passes `context.storage`): sessionStarted at arm (file before first
  crossing), sessionUpdated in onLap (BEFORE the announcement, the rig-proven
  order) and after discard, `void flush()` at stop and in destroy() (teardown
  rule, fire-and-forget). All persister entry points are synchronous —
  never-block holds by construction. Persister state mirrors into `$state`
  (`session.persisterState`) but is rendered ONLY on the stopped panel:
  "Session saved." / "Saving session…" (pending, no error) / "Some laps may
  not be saved (retrying/kind: message)" — the plan's after-Stop-not-mid-
  flight rule; the `state.pending`-aware wording covers the flush-never-
  settles caveat from Wave C.
- **Note editing (stopped panel):** `session.setNote()` writes the note onto
  the engine's session object (scope forbids core changes; the engine already
  hands out the mutable session, same pattern discard uses) and pushes it
  through `persister.sessionUpdated` — one write path, and the saved/unsaved
  indicator stays honest. Allowed in 'stopped' only.
- **Note editing (session view):** SessionView edits a local copy and saves
  via a new `SessionsRepo.saveSession` (insert-or-replace; updates the listed
  summary in place) — the repo layer, not raw storage, so failures land in
  lastError like every other repo op. Explicit "Save note" button (only shown
  while dirty), disabled in read-only mode.
- **Speech toggle** ("spoken lap times") sits on the SETUP panel next to the
  calibration fields, persisted via `coursesRepo.updateSettings`. fly-session
  reads `speechEnabled()` at announcement time, skipping the announcer only —
  test-mode beeps stay (they're setup feedback, not speech). announcer.reset()
  now runs at both arm and stop boundaries.
- **lastCourseId** is set on arm via an `onArmed` callback (fire-and-forget
  updateSettings) — the "most recently flown course" semantics D1 deferred.
- **CourseView:** all-time records via `courseRecords` over the course's full
  session bodies — the storage.md v1 full-scan (no index file); the same pass
  fills a per-session best-lap map for the list. Session list renders from
  summaries (newest first per contract) with date, valid-lap count
  (+ discarded count), best lap, linking to `#/session/<id>`.
- **Export delivery:** "Export data" button on Home above the diag/lab links:
  `exportAllToBlob(context.storage)` → shared `downloadBlob` (moved from
  src/ui/lab/ to src/ui/shared/, now accepting a ready-made Blob; lab
  importers updated — the only src/core touch is the stale path in export.ts's
  comment). Success/failure notice inline; Home reloads coursesRepo after
  export so the settings mirror sees the helper's lastExportAt update.
- **Mid-phase checkpoint proof** (fly.browser.test.ts, Chromium-gated like
  the rest of the capture tests): full flow against REAL OpfsStorage in a
  throwaway OPFS subdir via the injectable rootDirectory — create course →
  camera → arm → inject 2 laps → WITHOUT stopping, a brand-new OpfsStorage
  over the same root (read-only, since the live tab holds the writer lock —
  exactly a post-tab-kill reopen's view) lists the session with ≥ 1 lap
  ("loses at most the last lap"); then Stop → note edit round-trips to disk;
  then the fly tab is torn down and SessionView renders the persisted laps
  from a fresh StorageContext over the same root.
- **Review-screen component tests** (review-views.browser.test.ts, both
  browsers, MemoryStorage through real App routing): course-view records +
  session list, session-view records/highlights/strikethrough/note-edit
  round-trip, unknown-id handling (also the quarantined-session path — the
  view can't distinguish, by design).
- **Item 11 audit:** the /lab fixture recorder still delivers exclusively via
  `downloadBlob` (RecorderPanel/AnnotationPanel); grep confirms no OPFS API
  use anywhere in src/ui outside the storage seam — the eslint seam rule +
  lint-seams.test.ts keep enforcing it.

## Deviations

Recorded in the review pass — both were silent omissions in the wave logs above.

- **Orientation binding NOT implemented (item 9).** detection.md's Orientation
  section is normative ("the app warns and invalidates detection until the setup
  orientation is restored") and item 9 listed "orientation binding per the Phase 3
  decision", but the productized setup shipped without it and no wave log said so.
  Decision: defer to Phase 7 explicitly — added to plan 07 item 7
  (capability/permission edge polish); detection.md's Orientation section now carries
  a "(Not yet enforced by the product UI — scheduled Phase 7.)" annotation so the
  spec doesn't overclaim.
- **Sensitivity controls are trigger-level-only (item 9).** The plan says
  "sensitivity controls"; the shipped setup panel exposes exactly one — the trigger
  level (slider + auto-suggestion + ROI drag). Diff threshold, EMA time constant,
  and strip count stay /lab-only tunables, reaching product sessions only through
  the prefill snapshot. Deliberate: detection.md already mandates "one user-facing
  trigger level", and multi-knob calibration was a /lab affordance, not a product
  requirement.

(The iOS install-before-data banner skip was declared up front — see
Pre-implementation "Skipped" — and is now also annotated on the roadmap's Phase 6
exit criteria.)

## Verification status

Honest ledger against the plan's Verification section, as of the review pass.

**CI-verified (runs in `check`; each suite was green when its wave landed, and the
review-pass code fixes re-verify the full set in CI before commit):**

- Contract suite against MemoryStorage (node, `memory-storage.test.ts`) and against
  OpfsStorage twice — fake OPFS in node (`opfs-storage.test.ts`) and real OPFS in
  Chromium (`opfs-storage.browser.test.ts`), including crash-simulation, quarantine,
  and real Web Locks read-only tests; WebKit runs informationally per ADR 0006.
- Never-block proof: `full-loop-storage.test.ts` (node), four-way byte-identical.
- Schema/migration, session-persister, export-assembly, routing, and repos unit
  suites (node).
- Component browser tests: course CRUD (`course-crud.browser.test.ts`), review views
  (`review-views.browser.test.ts`), the persisted fly flow with the mid-phase
  durability checkpoint (`fly.browser.test.ts`, Chromium-gated capture tests).

**Manual on-device, still owed (tracked, not blocking the merge):**

- The plan's S22 flow pass: create course → calibrate → test → arm → fly → kill the
  tab mid-session → reopen with at most the last lap lost; prefill; records and
  highlights across discards; export file downloads with envelope + all data. CI
  proves the browser-level equivalents; the phone pass has not been run.
- Real tab-kill durability (the CI checkpoint simulates the reopen with a second
  OpfsStorage over the same root; an actual process kill on the device is the
  honest form).
- OPFS `/diag` probes on the S22 — the on-device citation ADR 0010 records as owed
  (ADR 0008).

## Review fixes — docs (2026-07-13)

Documentation follow-ups from the Phase 6 review (docs findings #1–#7), applied by
the docs fixer; code findings were handled in parallel and these docs describe the
post-fix state.

- **#1 testing.md:** status paragraph rewritten to Phase 6; Browser-contract section
  now states the correct node/browser split in present tense (never-block proof +
  MemoryStorage contract + fake-OPFS contract run in node; real-OPFS contract +
  crash sims + Web Locks in the Chromium browser project) and lists the new UI
  component tests; Video-E2E section gained the storage full-loop variant
  (full-loop-rig.ts + full-loop-storage.test.ts, four-way byte-identical).
- **#2 orientation:** deferral executed — plan 07 item 7 amended, detection.md
  Orientation annotated, and the omission recorded under "## Deviations" above.
- **#3 CLAUDE.md:** disputed — stale finding. CLAUDE.md has been ADR 0009-aligned
  (WebCodecs capture, CPU reduction, no WebGPU requirement) since Phase 3; verified
  against the file on disk. No change.
- **#4 product.md:** Speech feedback gained the speech on/off toggle sentence
  (stored setting; silences lap announcements only, test-mode beeps unaffected).
- **#5 roadmap:** Phase 6 exit-criteria "iOS install-before-data guidance live"
  annotated "(dropped — ADR 0008: export/import is the migration path; no iOS
  device)".
- **#6 notes:** "## Verification status" section added above.
- **#7 storage.md:** multi-tab notice wording loosened to describe "a read-only
  notice" rather than quoting UI copy; persist() timing documented (requested once,
  after the first successful write); plus one sentence distinguishing
  unsupported-version refusal (in place, file untouched) from quarantine, matching
  the parallel code fix.
- Note on Wave C above: `exportAllToBlob`'s lastExportAt side effect was flagged in
  review (code finding, handled by a parallel fixer); the wave log describes the
  as-built Phase 6 behavior at merge time of that wave.

## Review fixes — storage integrity (2026-07-13)

Applied by the storage fixer (src/core/storage/** only). Contract changes other
layers must honor are marked **[CONTRACT]**.

1. **Unsupported versions refused in place (SI#1).** `SchemaVersionError extends
   SchemaError` thrown by the migration driver for newer-than-app AND
   missing-intermediate-migration; `readDocument` maps it to a thrown
   StorageError of the NEW kind **[CONTRACT]** `'unsupported-version'`
   (+ `isUnsupportedVersionError` guard) — no quarantine, file untouched.
   Adding the kind was judged cleaner than overloading 'corrupt' (Phase 7
   import needs exactly this refuse-newer rule). **[CONTRACT]** `loadCourses`
   now REJECTS on an unsupported-version courses.json instead of returning
   defaults — returning defaults would let the next settings write entrench an
   empty file over intact data. listSessions/latestSessionForCourse skip such
   files (availability over completeness, documented on the interface).
2. **exportAll fails loudly (SI#2).** `loadAllSessions` gained a mode:
   **[CONTRACT]** `exportAll` ('strict') now REJECTS on any per-file
   infrastructure read failure or unsupported version instead of silently
   omitting sessions. Quarantined-corrupt files remain the only omissions —
   verified: the scan's own read quarantines them (moves aside + fires
   onQuarantine), so they cannot be silently absent. listSessions keeps
   skip-and-continue for ALL unreadable files; those infra skips stay silent
   (judged: no consumer for a skip count exists, the same file's loadSession
   surfaces the error, and the rollback scenario fails loudly at loadCourses
   first) — documented on the Storage interface and in storage.md.
3. **Web Locks denial retried once (SI#5).** A denied ifAvailable request now
   schedules ONE re-request (LOCK_RETRY_DELAY_MS = 1500 ms; injectable
   `scheduleLockRetry` option) before writerLockGranted settles read-only.
   Writes await the grant answer, so nothing races the retry window. Unit +
   real-Web-Locks browser tests: still-denied stays read-only (request count
   pinned); deny → predecessor release → retry grants → writes work.
4. **root() no longer caches rejection (TS#4).** A failed root open clears the
   cached promise so the next operation retries; pinned with a
   fails-once-then-succeeds fake.
5. **Validate before write (SI#7).** saveCourses/saveSession run the schema
   parse on the full envelope before writing; a SchemaError becomes an
   immediate StorageError 'write-failed' with the `$`-path message, nothing
   touches disk (pinned: bad startedAt / bad settings → reject, no file, no
   sessions/ dir). OpfsStorage only — MemoryStorage stores domain objects and
   has no delayed-quarantine failure mode to prevent.
6. **export.ts shrunk to pure assembly (TR#1 + architect#3 + simplicity#6 +
   TS#3).** **[CONTRACT]** `exportAllToBlob` no longer records
   settings.lastExportAt (the vacuous constant-clock pin plus the write are
   deleted); it returns `{ blob, filename, exportedAt }` — `exportedAt` added
   so the UI layer records lastExportAt through CoursesRepo after delivery
   (the screens fixer's Home.svelte already consumes it; contract met from
   both sides). New pin: assembly leaves settings untouched.
7. **Transient-read-failure path pinned (TR#2).** Fake OPFS gained a
   `beforeRead` hook; pins: loadSession rejects kind 'corrupt', NO quarantine
   event, bytes untouched; listSessions skips without quarantining; exportAll
   rejects (per #2).
8. **Migration-driver stamping pinned (TR#4).** `migrateToCurrent` exported
   with an optional targetVersion (test seam; production parse* always targets
   SCHEMA_VERSION); a temporary two-step chain asserts the second migration
   observes schemaVersion === 1 on its input, and a missing intermediate
   migration throws SchemaVersionError.
9. **Prune (simplicity#3, storage half).** Public `requestPersist()` deleted —
   its only consumer was its own test; the lazy persist request on first
   successful write stays (private, unchanged semantics, still pinned).
   Error-kind guards KEPT (judged: contract suite uses isNotFoundError, the
   storage tests use the rest, and the persister/repos discriminate on kind —
   cheap, real API surface).

Verification: typecheck clean; unit suite 792/792; storage browser tests 26/26.
Full `test:browser` had one failure in src/ui/fly (read-only banner test using
a UI-side fake — parallel screens fixer's in-flight work, not storage);
`lint` had one error in FlyFlow.svelte (same territory). Spec updated:
storage.md (writer-side validation, lock retry, export strictness, refusal of
unmigratable documents).

### Disputed findings

None rejected outright. Judged variations: listSessions infra-skips stay
silent (finding #2 left this open; rationale above), and finding #5's
validate-before-write was scoped to OpfsStorage only (MemoryStorage has no
file layer to poison).

## Review fixes — fly + persister (2026-07-13)

Findings owned: fly UI (src/ui/fly/**) + session-persister. All verified via
typecheck + lint + unit (792) + browser (63) green.

- **architect#2 (read-only gating in the fly flow):** FlyFlow now derives
  read-only LIVE off the storage instance (structural check: any storage
  exposing a boolean `readOnly` — OpfsStorage does — is read directly;
  otherwise `context.readOnly`), because the context mirror only refreshes
  after repository operations while the Web Locks answer settles — and with
  the delayed lock re-request can flip — asynchronously after load. The flow
  polls it every 500 ms AND re-derives it inside the guarded `arm()` click
  handler, so a flip the poll hasn't seen yet still refuses at the moment of
  truth. FlyFlow renders the warning banner above both the setup and test
  panels (the finding said FlySetupPanel; FlyFlow covers the test panel's Arm
  button too) and both panels take `arm`/`armDisabled` props instead of
  calling `session.arm()` directly. **Test mode stays enabled read-only** —
  it records nothing and writes nothing, so gating it would only obstruct
  calibration. Browser tests: a poll-only flip test (both directions, no
  camera) and a Chromium camera test pinning the click-time re-check
  (flip → immediate Arm click → never arms) and re-enable on flip-back.
- **TS#5 (stale announcements):** `destroy()` now calls `announcer.reset()`
  before teardown — a queued lap announcement no longer speaks over the next
  screen. (Arm and stop boundaries already reset.)
- **TS#6 + SI#3/4 + architect#5 (re-arm race):** went with the pending-based
  disable, NOT chaining sessionStarted behind flush(): flush never resolves
  against a hung storage, so an await-based gate would wedge invisibly,
  while the disable is honest ("Saving previous session…" note in FlyFlow,
  Arm disabled in both panels) and self-resolves through the persister's
  retry budget — a FAILING storage eventually spends its budget, pending
  drops, lastError stays surfaced, and Arm re-enables. Walked the hung-storage
  corner: pending stays true forever and Arm stays disabled forever — judged
  correct, since a new session's writes would hang identically; the disable
  reports the truth instead of recording an unsavable session.
  `fly-session.arm()` also guards on `persister.state.pending` (authoritative
  even past the button), and the ownership rule comment is in the persister
  header: a session is repo-editable only once its persister is quiescent.
  "New session" stays enabled — it only returns to setup and drops nothing;
  the gate lives at Arm. Chromium test drives the whole sequence with a
  gateable MemoryStorage (hung lap write → Stop → New session → gated +
  note → release → re-arm works).
- **TS#8 (note loss on Back):** stopped-panel textarea persists on `input`
  instead of `change` — per-keystroke setNote is one structuredClone of a
  small session with persister coalescing (at most one write in flight);
  no perf concern. Browser-test helper now dispatches `input`.
- **Simplicity#3 (persister prune):** `SessionPersisterOptions.retryDelaysMs`
  deleted (no caller passed it); `DEFAULT_RETRY_DELAYS_MS` stays exported
  (tests pin the schedule) and the scheduler stays injectable.
  `savedLapCount` KEPT and redeemed: the stopped panel's unsaved warning now
  appends "Saved through lap N." (N > 0) so the pilot knows which laps are
  safe. `retryScheduled` REMOVED from PersisterState — no UI consumer, and
  `pending` already covers retry-pending; the retry *scheduling* behavior
  stays pinned through the FakeScheduler assertions, so the suite stays
  honest. API change: `PersisterState` is now
  `{ pending, lastError?, savedLapCount? }`.
- **TR#5 (storage-independent announcements, optional):** closed via the
  extraction the P5 architect asked for (architect#4): new
  `announceCompletedLap(announcer, lap, sessionLaps)` in
  core/announcer/announcer.ts is now the single lap→announcement hookup used
  by BOTH fly-session's onLap and full-loop-rig's createArmedSessionRig — the
  rig-mirror contract is structural, not a comment promise, so
  full-loop-storage.test.ts's proof (announcement decisions byte-identical
  under no/hung/failing storage) covers the product wiring. fly-session's
  onLap comments point at the rig + proof. Skipped the extra fly-session
  hanging-storage browser test: FlySession doesn't expose the decision log,
  and adding a seam only for that test would outweigh its value now that the
  hookup is shared.

## Review fixes — data + screens (2026-07-13)

Fixer scope: src/ui/data/**, src/ui/screens/**, App.svelte + their browser
tests. Per finding:

1. **Stale SessionsRepo (architect#1/TS#1).** CourseView now calls
   `sessionsRepo.refresh()` on mount instead of `ensureLoaded()` (App keys
   the view on courseId, see 3 — so mount = each visit); the invalidation
   rule ("writes bypassing the repo — the flight persister, Phase 7 import —
   leave summaries stale; readers must refresh()") is stated on
   SessionsRepoView.refresh in storage-context.ts and in repos.ts. No
   separate `invalidate()` — refresh() IS the invalidation point (judged:
   an alias adds surface, not capability). Browser pin in
   review-views.browser.test.ts: save a session behind the repo via
   `storage.saveSession`, leave, revisit → listed.
2. **Sticky lastError (TS#2).** Split the SessionsRepo API in two:
   list/save ops (refresh, saveSession) set lastError on failure and clear
   it on success (new pin); per-caller queries (loadSession,
   latestForCourse) no longer touch lastError at all — SessionView's
   not-found message and CourseView's records scan handle misses locally,
   so a single unreadable session cannot plant an app-wide banner.
   CourseView counts skipped sessions and shows a local "N sessions could
   not be read" warning instead. repos.test.ts updated.
3. **CourseView {#key} (TS#7).** App.svelte keys CourseView on
   route.courseId; browser pin: direct `#/course/A` → `#/course/B` hash
   edit shows B's records/sessions, not A's.
4. **courses.json lost updates (TS#3).** CoursesRepo serializes writes
   (saveCourse/updateSettings) through an internal promise queue; each op
   re-reads the snapshot after awaiting its predecessor, so concurrent
   read-merge-write cycles can't drop each other. Reads stay unqueued
   (queuing reload would deadlock the ensureLoaded a queued write awaits).
   Pins: two concurrent updateSettings both land; saveCourse racing
   updateSettings both land; a failed queued write doesn't block the queue.
   Home export now records lastExportAt via
   `coursesRepo.updateSettings({ lastExportAt })` using exportAllToBlob's
   returned exportedAt (coordinated contract with the storage fixer:
   `{ blob, filename, exportedAt }`, landed and verified), replacing the
   `repo.reload()` dance.
5. **Repo triple-declaration (simplicity#1).** The mirror's
   courseById/sessionsForCourse re-implementations replaced by shared pure
   helpers (findCourseById/filterSessionsForCourse) used by both class and
   view; the per-file Snapshot interfaces + snapshot functions in
   storage-context.svelte.ts replaced by `snapshot` getters on the repo
   classes. The view interfaces stay hand-written in storage-context.ts
   (judged: deriving them from the factory return type would invert the
   interface-file convention — types importing from the .svelte.ts impl).
6. **Session list from full bodies (simplicity#4).** CourseView renders the
   list from the records pass's fully-loaded sessions (precomputed
   SessionListItem view models); bestBySession and the template's summaries
   dependency deleted. Summaries still drive the scan order + remain API
   for other consumers.
7. **Shared records/notice styling (simplicity#5).**
   src/ui/shared/RecordsSummary.svelte extracted (records + optional
   lapCount), used by SessionView and CourseView; FlyStoppedPanel can adopt
   later (noted in the component). Error/notice style: App-level
   `:global(.notice-error)`/`:global(.notice-warning)` classes (judged the
   cheapest honest form vs. a component wrapping one <p>); Home,
   CourseView, SessionView, CourseForm, Fly loader, and the quarantine
   panel migrated, local duplicate rules deleted (screens keep only layout
   like margins).
8. **toRepoError un-exported (simplicity#3).** Module-private; no external
   users existed.
9. **instanceof OpfsStorage coupling (architect#4).** Replaced with a local
   structural capability check (typeof storage.readOnly === 'boolean' /
   typeof storage.dispose === 'function') in storage-context.svelte.ts —
   coordinate-free (no src/core/storage edit), and lets any storage opt
   into read-only/dispose. OpfsStorage import remains only as the default
   createStorage.
10. **Error/read-only/quarantine UI browser tests (TR#3, screens half).**
    New src/ui/screens/storage-status.browser.test.ts, three cases through
    real App + MemoryStorage variants: readOnly field → Home banner
    (exercises the structural check from 9); rejected saveCourses → course
    form shows the storage error and stays put; injected onQuarantine event
    → dismissable app-level notice. FlyStoppedPanel save-state pinning left
    to the fly fixer per scope.

Verification (final, after the storage fixer's export contract landed):
typecheck 0 errors, lint clean, unit 792/792, test:browser (chromium)
63/63 across 9 files, build green. `test:browser-webkit` cannot launch on
this host (Playwright system deps missing — environmental, pre-existing;
CI covers it).

### Disputed findings

None. Judged variations noted inline above (1: refresh() reused instead of
a new invalidate(); 2: queries vs ops error split; 5: view interfaces kept
hand-written).
