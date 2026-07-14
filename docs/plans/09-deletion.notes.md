# Phase 9 (deletion) — implementation notes

Staging notes for [`09-deletion.md`](09-deletion.md). Assumptions, judgment calls and open
questions raised while implementing. Promote anything durable into the spec or ADR 0011.

## Pre-implementation (2026-07-14)

Plan: `docs/plans/09-deletion.md` (revision 2 — post adversarial review).
Working tree was clean at start (only the untracked plan itself).

### Assumptions

- **`exportAll` is routed through `CoursesRepo`'s critical section by adding
  `CoursesRepoView.exportAll()`**, and `exportAllToBlob` (`src/core/storage/export.ts`) is changed
  to take an envelope-producer rather than calling `storage.exportAll()` itself
  (`export-action.ts:30` calls it with the raw `Storage` today). Plan item 6 requires export to be
  serialized against a cascade but does not say how to thread it. If wrong, the alternative is a
  mutex in `StorageContext` shared by both.
- **No `SCHEMA_VERSION` bump.** `pendingCourseDeletions` is an added optional `AppSettings` key;
  `parseSettings` is extended to read and validate it. Old apps drop the key on their next write,
  degrading to the un-marked partial state (fails safe). No migration entry is added.
- **`MemoryStorage` carries the same `deletedSessionIds` / `deletedCourseIds` guards** even though
  its writes are synchronous, so the shared contract suite cannot tell the two implementations
  apart.
- **The resume runs once per `StorageContext` construction**, fire-and-forget, and its outcome
  notices render in `App.svelte` beside the existing quarantine notices (not on Home — a relaunch
  may restore any hash route).
- **`bun run check` (typecheck + lint + unit tests + build) is the acceptance gate.** Browser-mode
  tests (`test:browser`) are run where the plan calls for them.

### Open questions

- The plan says the confirm screens keep Delete **disabled until session counts have loaded**. On a
  cold deep-link into `#/course/<id>/delete` that means a visible loading state before the button
  arms. Assumed acceptable (it is the fix for the "says 0 sessions, deletes 12" bug) — flagging in
  case a spinner-then-arm feels wrong in the field.
- `ResumeOutcome.kind === 'abandoned'` (course flown again since an interrupted delete) leaves the
  course intact and clears the marker. The user is told, but is not offered a "delete it now"
  action. Assumed correct: re-deleting is two taps and re-confirms the real, current blast radius.

### Concerns / risks

- **Blast radius is wide**: the `Storage` interface grows three members, which intentionally breaks
  every hand-written `Storage` literal in the tests (`repos.test.ts:7`, `session-persister.test.ts:405`).
  Those compile errors are the feature — they enumerate everything claiming to implement the seam.
- **`docs/mockups/ui-mockups.html`** gains three screens. It is the design source of truth and has
  no delete affordance today; leaving it silent is how this class of gap went unnoticed for seven
  phases.
- The `deletedCourseIds` guard makes `saveSession` reject for **any** session of a deleted course.
  `importAll` must re-admit both id sets before delegating to `importIntoStorage`, or importing an
  export containing deleted data aborts mid-import.

## Phase 1 — storage seam

`src/core/storage/storage.ts` — types and contract comments only, per plan item 2. No
implementation, no other files touched.

### Assumptions

- **The three members are appended after `persistenceStatus()`**, i.e. at the end of the `Storage`
  interface, matching the plan's "…existing 9 members…" sketch rather than grouping them next to
  the read/write pairs they relate to. The interface's existing order is a rough lifecycle
  (load → save → list → export → import → status), and deletion arriving last reads as the newest
  chapter rather than as an edit to an old one.
- **`DeleteCourseResult` and `ResumeOutcome` live in `storage.ts`, not `schema.ts`.** They are seam
  vocabulary (what a caller is told), not file-format vocabulary. `PendingCourseDeletion` — the
  thing that is actually serialized — stays in `schema.ts` per item 1, and `storage.ts` deliberately
  does **not** import it: the seam trades in domain shapes and never exposes the envelope (the file
  header's stated rule, with `exportAll` as its one deliberate exception). `ResumeOutcome` therefore
  restates `courseId` / `courseName` instead of embedding the marker.
- **The "no new `StorageErrorKind`" note is attached to the `StorageErrorKind` union**, not to the
  delete methods — that is where a future contributor stands when they are about to add
  `'delete-failed'`. It also names the `guardWriter()` / `LOCK_RETRY_DELAY_MS` point (the UI's
  `disabled={context.readOnly}` is cosmetic; the storage layer is the real guard), so the reason a
  read-only tab is harmless is recorded next to the kinds it fails with rather than only in the plan.

### Open questions

- `deleteCourse`'s contract says it clears `settings.lastCourseId` "in the commit write". A reader
  could ask why not in the INTENT write too — the answer (a crash between 1 and 3 leaves
  `lastCourseId` pointing at a course that still exists, which is harmless, whereas clearing it
  early would be a user-visible change with no deletion to show for it) is *implied* by the
  two-phase comment but not stated. Left implicit to keep the comment from sprawling; say it in
  `storage.md` (item 12) instead if it is worth saying.
- The contract does not say what `deleteCourse` does about an **unreadable** session file that
  belongs to the doomed course. Per plan items 3 and 12 it survives the cascade (its `courseId`
  lives in bytes we could not parse, so `listSessions` cannot attribute it), which makes it an
  orphan — but that is a property of the shared cascade's use of `listSessions()`, not of the seam,
  so it is documented in `storage.md` and ADR 0011 rather than here. Flagging in case a reviewer
  expects the interface comment to carry it.

### Noticed, out of scope

- **The compile-break surface is much wider than the plan's Verification section says.** It names
  `repos.test.ts:7` and `session-persister.test.ts:405`. `tsc -b` after this change breaks **14
  files** and **6 distinct hand-written `Storage` doubles** — `ControlledStorage`, `FailingStorage`,
  `HangingStorage`, `FlaggableStorage`, `GateableStorage`, plus `MemoryStorage`/`OpfsStorage`
  themselves — across `src/core/full-loop-storage.test.ts`, `src/core/storage/export.test.ts`,
  `src/core/storage/memory-storage.test.ts`, `src/core/storage/opfs-storage.test.ts`,
  `src/core/storage/opfs-storage.browser.test.ts`, `src/ui/data/storage-context.svelte.ts`,
  `src/ui/fly/fly.browser.test.ts`, `src/ui/fly/fly-orientation.browser.test.ts`,
  `src/ui/fly/backup-nudge.browser.test.ts` and `src/ui/screens/storage-status.browser.test.ts`.
  This is the intended enumeration working as designed, but whoever fixes the doubles should expect
  the browser-test files too, not just the two the plan lists. Zero errors originate inside
  `storage.ts` itself; `eslint src/core/storage/storage.ts` is clean.

## Phase 1 — schema

- **Assumption:** an **empty `sessionIds` array is valid**. A course with no sessions is legitimately
  deletable, and the cascade writes the marker before it knows whether the list is non-empty. If
  wrong (i.e. the marker should never be written for an empty work list), the validator would reject
  `[]` and `deleteCourseFromStorage` would have to skip step 1 entirely for a session-less course —
  which would also be sound, since there is nothing to interrupt.
- **Assumption:** `courseName` is validated as a **string, not a non-empty string** (only `courseId`
  is required non-empty, per the plan's wording). A course name is user-supplied and the cascade
  substitutes `'Unknown course'` when the course is already gone, so an empty name is a display
  nuisance, not a correctness hazard — and rejecting it would make a marker unreadable, which fails
  *unsafe*: an unparseable `courses.json` is quarantined, taking the work list with it.
- **Assumption:** **no duplicate-`courseId` check** across the marker array. The resume loop treats
  entries independently and each ends with its own commit write, so a duplicate resolves to a
  no-op second pass rather than data loss. Adding the check would mean a validator that can
  quarantine `courses.json` over a condition the code tolerates.
- **Assumption:** extracted `asString(value, path)` (element-level) and had the existing
  `stringField` delegate to it — the same pairing `asObject`/`objectField` already uses — because
  `sessionIds` needed to validate array *elements*, which no existing helper did. `stringField`'s
  behavior and error message are unchanged. New `nonEmptyStringField` is used only by `courseId`;
  it was deliberately **not** retro-applied to `Course.id` / `Session.id` (out of scope, and would
  change what existing files parse).
- **Open question:** nothing validates that a marker's `courseId` refers to a course that exists, or
  that its `sessionIds` exist. That is correct for a *schema* validator (the marker outlives both by
  design — that is the whole point), but it means a hand-edited or truncated `courses.json` can
  carry a marker naming nothing. The resume is idempotent and `deleteSession` resolves on unknown
  ids, so this should be harmless; the crash-simulation tests (item 4 / Verification) would confirm
  it.

## Phase 1 — backup nudge + export filename

### Assumptions

- `hasUnexportedSessions` takes the same `sessionSummaries` shape as the nudge
  (`ReadonlyArray<Pick<SessionSummary, 'startedAt'>>`), so the delete-confirmation screen can pass
  the *doomed* subset of `SessionsRepo.summariesList` straight in with no adapter. Both inputs are
  named types (`UnexportedSessionsInput`, and `BackupNudgeInput extends` it) so the nudge cannot
  drift from the predicate it is built on.
- Boundary kept identical to the old nudge: a session starting **exactly at** `lastExportAt` counts
  as exported (strict `>`); the recency gate stays strictly `>` 7 days. `shouldNudgeBackup`'s
  observable behaviour is unchanged — its existing tests pass unmodified.
- `buildExportFilename` gaining seconds changes no other test: the browser tests
  (`e2e.browser.test.ts:248`, `backup-nudge.browser.test.ts:104`, `portability.browser.test.ts`)
  all assert on the `chronowhoop-export-` prefix only. Nothing parses the filename back into a date.

### Noticed, out of scope

- `docs/specs/storage.md:89` states the nudge rule in prose and now also needs the *filename*
  format and the new `hasUnexportedSessions` split when item 12's doc pass lands; the filename
  format itself is documented nowhere in `docs/specs/` today (only in
  `docs/plans/06-persistence-product-ui.notes.md:213`).
- `src/ui/fly/FlyStoppedPanel.svelte:33` is the only caller of `shouldNudgeBackup` and is untouched.

## Phase 1 — delete.ts cascade

`src/core/storage/delete.ts` + `src/core/storage/delete.test.ts` (20 tests, green). Modelled on
`import.ts` (`ImportTarget` + `importIntoStorage`): `DeleteTarget` + `deleteCourseFromStorage` +
`resumePendingDeletionsFromStorage`, plus the three pure `courses.json` transforms
(`withPendingDeletion`, `withoutPendingDeletion`, `withoutCourse`). No other file touched.

### Assumptions

- **`resumePendingDeletionsFromStorage` NEVER REJECTS — the invariant lives in the shared code, not
  in the two implementations.** The plan's sketch (item 3) propagates, while the seam contract
  (`storage.ts`) says `resumePendingDeletions` never rejects; putting the try/catch in each
  implementation would duplicate exactly the invariant this file exists to make unduplicatable. So:
  a failing initial `loadCourses()` resolves `[]`, and a failing **entry** keeps its marker, emits
  no outcome, and does not stop the remaining entries. Implementations can therefore delegate with
  a bare `return resumePendingDeletionsFromStorage(this)`; an extra catch in an implementation is
  harmless but redundant. (`deleteCourseFromStorage` does the opposite and propagates — the confirm
  screen has a human standing in front of it who can retry.)
- **`withPendingDeletion` REPLACES an earlier marker for the same course rather than appending a
  second one.** An earlier marker's ids are either already deleted (which is why they are absent
  from the fresh `listSessions()` the new marker is built from) or still live and therefore present
  in the new list too — so nothing is lost, one course keeps one work list, and a re-delete after a
  crash produces one resume notice instead of two. The schema validator deliberately tolerates
  duplicate `courseId`s (see the schema notes above); this keeps them from arising in the first
  place.
- **The INTENT and COMMIT writes are unconditional**, even for a course with zero sessions and even
  for an unknown course id. Skipping them when the work list is empty would be sound (there is
  nothing to interrupt), but it would make the write sequence depend on state, and the idempotent
  re-delete path still needs the COMMIT write to clear a stale marker.
- **`lastCourseId` is cleared in the COMMIT write only**, never in INTENT — a crash between the two
  then leaves `lastCourseId` pointing at a course that still exists (harmless), rather than a
  user-visible change with no deletion to show for it.
- **Empty means absent:** `withSettings` deletes `pendingCourseDeletions` when the last marker goes
  rather than writing `[]`, so `courses.json` never carries a permanent "a deletion is in flight"
  key.

### Open questions

- `resumePendingDeletionsFromStorage`'s per-entry catch swallows the error object entirely (the
  marker surviving is the signal). There is no channel here to report *why* a resume failed — the
  implementations have a quarantine-notice channel; deciding whether a failed resume deserves one
  is item 10's call, not this file's.
- Nothing bounds how long a marker can sit pending. A user who fails a delete and never grants the
  write lock again (permanently read-only second tab) keeps the marker forever, and every launch
  retries it. Harmless, but unbounded.

### Noticed, out of scope

- **`importIntoStorage` still has the stale-snapshot hole** (`import.ts:131-136`): its course
  write-back is built from the `loadCourses()` it took at the top, so a `deleteCourse` committing
  during the session-write loop is reverted by it. Plan item 6 addresses this by serializing both
  through `CoursesRepo.enqueueWrite`, which is the right fix at the right layer — noting only that
  the hole is real in the storage layer itself and that `delete.ts` deliberately does not reproduce
  it (every commit write is built from a fresh read).
- An **unreadable** session file is invisible to `listSessions()`, so it cannot be attributed to a
  course and survives the cascade as an orphan. Commented in `delete.ts`; needs the `storage.md` /
  ADR 0011 wording from item 12.
- `listSessions()` on OPFS **is** a `readDocument` scan and **does** quarantine corrupt files as a
  side effect, so a delete can produce a quarantine notice. Commented honestly rather than glossed.

## Phase 1 — MemoryStorage

`src/core/storage/memory-storage.ts` only (plan item 4). The three new members delegate to the
shared cascade; `saveSession` gains the resurrection guard; `importAll` re-admits the envelope's ids
first. No test file changed — see below.

### Assumptions

- **`memory-storage.test.ts` was left untouched.** Every behaviour this task adds (cascade scope,
  idempotent double-delete, unknown-id resolve, both arms of the guard, `importAll` re-admission,
  the re-import-restores-everything pin, and the resume/abandon semantics) is contract-level: it must
  hold for `OpfsStorage` identically, so it belongs in `storage-contract.ts`'s new `describe('deletion')`
  (another agent's file). Duplicating it in the MemoryStorage-specific block would create a second
  place for the semantics to drift. The existing `MemoryStorage specifics` block stays what it is —
  the injected-clock test, the one thing that genuinely is not shared.
  **All of it was nevertheless verified** against this implementation via a throwaway spec run before
  the contract tests landed (7 cases, green, then deleted); if the shared suite ends up not covering
  one of them, the gap is in the suite, not here.
- **`deletedCourseIds.add(id)` happens BEFORE `deleteCourseFromStorage`, not after.** The guard has to
  be closed while the cascade runs: a session armed moments earlier may not be in the cascade's
  `listSessions()` snapshot at all, so `deletedSessionIds` can never learn its id — the course set is
  the only thing that can catch it. Same for `deletedSessionIds.add(id)` before the map delete.
- **The guard's rejection message is per-session, not per-course** ("session X was deleted and cannot
  be re-created") even when it is the *course* set that fired. The caller is a straggling
  `SessionPersister` write, which only cares about the kind (`not-found` is not retried;
  `write-failed` is — `session-persister.ts`), and a message that named the course would be misleading
  in the far commoner session-delete case.

### Noticed, out of scope

- **The post-write recheck is genuinely unnecessary here and the fields are genuinely necessary.**
  `MemoryStorage`'s writes are synchronous, so there is no window between the pre-check and the
  `Map.set` for a `deleteSession` to slip into — no compensating remove, no second `assertNotDeleted`.
  Likewise OpfsStorage's "a **failed** `deleteSession` must un-record the id" rule is **vacuous** here:
  nothing in this implementation can fail, so the id is never recorded for a session that still
  exists. Both facts are commented in the file, because the natural reading of a MemoryStorage that
  carries the fields but not the compensation is "someone forgot half the guard" — and the natural
  "fix" (dropping the fields, since the store cannot resurrect anything anyway) would make the
  contract suite pass on a store that accepts writes the real one rejects, which is precisely the
  bug the suite exists to catch.
- `repos.test.ts`'s `failingStorage` and `session-persister.test.ts:405`'s double are hand-written
  `Storage` literals and still do not compile — expected (plan Verification: "compile breaks are the
  feature"), and not this task's file. Repo-wide `tsc -b` reports **zero** errors originating in
  `memory-storage.ts`; `eslint src/core/storage/memory-storage.ts` is clean.

## Phase 1 — Storage test doubles

Compile-fix only: two hand-written `Storage` object literals gained the three new members. No
assertion, no fixture and no test behaviour changed. Unit suite green unchanged (70 files, 879
tests).

### What actually broke (vs. the 14-file / 6-double survey)

The survey counted `tsc` *errors*, most of which were **downstream** of `MemoryStorage` and
`OpfsStorage` not yet implementing the members — not doubles needing repair. Only **two** files
contain a double that has to be written by hand:

- `src/ui/data/repos.test.ts:7` — `failingStorage` (object literal).
- `src/core/session/session-persister.test.ts:405` — `storageAsInterface` (object literal).

Every other double is a **subclass of `MemoryStorage`** that overrides exactly the one method it
gates or fails, and therefore inherits the three new members for free once `MemoryStorage`
implements them: `ControlledStorage` (session-persister.test.ts:51), `HangingStorage` /
`FailingStorage` (full-loop-storage.test.ts:68,77), `FlaggableStorage` / `GateableStorage`
(fly.browser.test.ts:32,38), `ReadOnlyMemoryStorage` (storage-status.browser.test.ts:63). Those
files needed **no edit at all**; their errors vanished the moment `MemoryStorage` landed.

### Judgment calls

- **`failingStorage` (repos.test.ts): the three members reject like every other one.** They reuse
  the existing `reject` helper, so the double stays what it is — a storage where *every* call
  rejects with the injected error. This is also the failure-path double the Phase 2 repo deletion
  tests will want, so it is now honest for a caller that has not been written yet. A `deleteCourse`
  that resolved here would be a lie.
- **`storageAsInterface` (session-persister.test.ts): the three members delegate**, matching the
  helper's whole purpose (rebinding `MemoryStorage`'s prototype-bound methods so a single method can
  be overridden — the sole user overrides `saveSession` to throw synchronously). Delegating keeps
  every non-overridden method backed by the real `MemoryStorage`.
- **The `MemoryStorage` subclasses were deliberately left alone rather than given explicit
  overrides.** Inheriting `MemoryStorage`'s real deletion is the honest reading of each: none of
  them is a "storage where writes fail" in general — `FailingStorage`/`HangingStorage` fail or hang
  **`saveSession` only** (their sibling methods, `loadCourses` included, already work), and none of
  their tests exercises deletion. Adding a rejecting `deleteCourse` to them would *invent* a
  behaviour the fixture never had. If a later phase wants a delete-fails double, it should say so
  explicitly rather than infer it from these.

### Noticed, out of scope

- After this change the only `tsc -b` errors left are in files owned by other agents:
  `opfs-storage.ts` (and the two test files that instantiate it), and `storage-context.svelte.ts`
  (Phase 2). `fly.browser.test.ts:721,771` also still errors, but purely because it constructs an
  `OpfsStorage` — it needs no double fix and will go green when `OpfsStorage` lands.

## Phase 1 — OpfsStorage

`src/core/storage/opfs-storage.ts` + `opfs-storage.test.ts` + `opfs-storage.browser.test.ts` (plan
items 4 and 5). The three new members, the two-set resurrection guard on `saveSession`, `importAll`
re-admission, and the strict-export integrity fix. Unit suite green (70 files, 892 tests); the OPFS
browser file is green against real Chromium OPFS (26 tests). `tsc -b` and `eslint` report zero
errors originating in these files.

### Assumptions

- **A failed `deleteCourse` un-records the course id too** — the plan only spells the un-record rule
  out for `deleteSession` ([R2], item 4). The symmetric hazard is real and identical: if the cascade
  rejects, its COMMIT write never landed, so **the course is still standing and can still be flown**
  — and a `deletedCourseIds` entry that outlives the failure makes every session flown on it reject
  `not-found` for the life of the tab, with the persister (which retries `write-failed` and nothing
  else) silently dropping laps. The sessions the cascade *did* remove stay guarded, because
  `deleteSession` recorded each of them individually and only un-records its own on *its* failure.
  The partial state this leaves is one the design already handles: the marker survives, and the next
  launch either finishes the deletion or abandons it as `flown-since`.
  **No contract-suite divergence with `MemoryStorage`:** nothing in that implementation can fail, so
  the rule is vacuous there (its own notes say the same about the session rule).
- **A session file listed and then read back `not-found` rejects with kind `'corrupt'`**, not
  `'not-found'` (plan item 5 says "must REJECT" without naming a kind). `'corrupt'` is this file's
  established taxonomy for a *read-side* failure of a file that should be there (`toReadError`), and
  `exportAll` rejecting `'not-found'` would collide with the kind `loadSession` uses to mean "no such
  session", which is exactly what this is not.
- **`resumePendingDeletions` gates on `await this.writerLockGranted`, not on the `readOnly` getter.**
  `readOnly` is still `false` for up to `LOCK_RETRY_DELAY_MS` while the lock request settles, so
  gating on it would let a soon-to-be-read-only instance start a resume whose every write then
  rejects. Awaiting the grant answer is the same guard `guardWriter()` uses, minus the throw.
- **The guard's rejection message names the session, never the course**, even when the *course* set
  fired — matching the wording `MemoryStorage` chose, so the contract suite cannot tell them apart.
- **`deleteSession` on a store with no `sessions/` directory resolves** (idempotence), rather than
  creating the directory in order to fail to remove something from it.
- **`deleteSession` records the id before any I/O**, including before the `sessions/` directory is
  opened — a `saveSession` racing it must lose from the earliest possible moment, and the un-record
  in the `catch` covers every way the I/O can then fail.

### Test-fake changes (unit)

- `FakeOpfsHooks.beforeCommit` may now return a promise (`close()` awaits it). That is what makes the
  compensation test **deterministic** rather than a microtask race: the delete runs to completion
  *inside* the save's commit, so `close()` demonstrably re-creates the file the delete just removed
  and the post-write recheck is the only thing that removes it again. Existing hooks that throw
  synchronously behave exactly as before.
- New `FakeOpfsHooks.beforeRemove` (throw to fail a `removeEntry`) — there was no way to make a
  removal fail, and the un-record rule is untestable without one.
- Both new tests were **verified non-vacuous by mutation**: deleting the post-write compensation, and
  disabling the strict `not-found` rejection, each fails exactly its own test and nothing else.

### Noticed, out of scope

- **The crash-simulation test lives in `opfs-storage.browser.test.ts`** ("an interrupted cascade: the
  marker survives a relaunch, and the resume finishes it"). It is the only test that proves
  `parseSettings` actually *reads* `pendingCourseDeletions` back off real bytes in a **fresh
  instance** — a shared in-memory fake would pass even if the key were dropped on read, which is the
  precise bug that would make the whole recovery mechanism inert dead code. It constructs the INTENT
  state via `saveCourses` rather than by killing a real cascade mid-flight (there is no injection
  point in real OPFS), which is the same crash state by definition.
- `storage-contract.ts` has **no `describe('deletion')` block yet** (another agent's file). Until it
  lands, cross-implementation deletion semantics are pinned only by the per-implementation tests:
  `opfs-storage.test.ts`'s new `describe('OpfsStorage deletion')` here, and — per its notes —
  *nothing* on the MemoryStorage side, which deliberately deferred all of it to that suite. If the
  shared suite is dropped or thinned, MemoryStorage's deletion ends up with no test at all.
- `exportAll` still calls `loadCourses()` and then `loadAllSessions('strict')` as two unsynchronized
  reads: a cascade committing *between* them yields an envelope whose course list is already missing
  a course whose sessions are still on disk (they would import back as orphans). Serializing export
  against the cascade is plan item 6's job (`CoursesRepo.enqueueWrite`), at the repo layer — noting
  only that the storage layer alone cannot close it, and the strict-mode fix here does not.

## Phase 1 — storage contract

`src/core/storage/storage-contract.ts` only: a new `describe('deletion')` block (13 cases, in five
sub-blocks — cascade, idempotence, resurrection guard, import re-admission, marker/resume). No
existing test weakened; no other file touched. Green in **both** projects from the one source:
`memory-storage.test.ts` 34/34 in node, `opfs-storage.browser.test.ts` 39/39 against real Chromium
OPFS. **No divergence found between the two implementations** — every assertion holds identically.

### Assumptions

- **The interrupted-cascade state is set up through `saveCourses`**, writing the marker into
  `settings.pendingCourseDeletions` by hand, rather than by killing a real cascade mid-flight (there
  is no injection point in either implementation, and none should be added for a test). That *is* the
  on-disk state a crash between INTENT and COMMIT leaves, by definition — and going through the
  public seam means the marker takes a real serialize/parse round trip on OPFS, which is what would
  catch a `parseSettings` that silently dropped the key.
- **"A resume deletes only the recorded `sessionIds`" is pinned via the partial-cascade shape**: the
  marker records two ids, one of whose files the crash already removed, and only one is still on
  disk. It cannot be pinned by recording a *subset* of a course's live sessions, because that is by
  construction the `flown-since` case — any live session of the doomed course that is not on the work
  list makes the resume abandon. The two tests therefore partition the space between them: recorded ⊇
  live → `completed`; live ⊄ recorded → `abandoned`.
- **`sessionsDeleted` counts the marker's recorded ids, not the files actually removed** (the
  partial-cascade resume above reports `2` while removing one file). That is what `delete.ts` does
  (`sessionsDeleted: pending.sessionIds.length`) and it is the honest number for the resume notice:
  it is what the *user confirmed*, and the already-removed file was removed by the same instruction.
  Pinned as-is rather than "fixed" to count removals.
- **The `abandoned` assertion checks `listSessions()` order explicitly** (`flownSince` before
  `confirmed`, newest-first) rather than sorting both sides — it costs nothing and one more test
  holds the ordering contract to account.
- **The import pin also asserts the ids are live again afterwards** (a `saveSession` on a *new*
  session of the restored course resolves), not merely that one import was permitted. The guard must
  have let go of the ids, not special-cased the import.

### Not covered here, deliberately

- **"A *failed* `deleteSession` leaves the session saveable"** (plan Verification, item 4's un-record
  rule). It is untestable in this suite: it needs a `removeEntry` that fails, and neither
  implementation offers a seam for that at the `Storage` interface. `MemoryStorage` cannot fail at
  all (its notes say the rule is vacuous there), and `OpfsStorage` already pins it in
  `opfs-storage.test.ts` via the `FakeOpfsHooks.beforeRemove` hook. Adding a failure injection point
  to the shared contract would mean widening `ContractStorage` beyond `Storage` for one test — the
  cost is a seam every future implementation must fake.
- **The crash/relaunch round trip** (a *fresh instance* reading the marker back off real bytes) stays
  in `opfs-storage.browser.test.ts`, where it belongs: it needs a second `OpfsStorage` over the same
  directory, which `ContractStorage` has no vocabulary for, and against `MemoryStorage` it would be
  vacuous (same object, same map).

### Noticed, out of scope

- `makeSession()`'s default `courseId` is the literal `'course-0000'`, which is *not* the id of any
  course `makeCourse()` produced unless the counter happens to line up. Harmless (and the existing
  orphan-import test relies on unmatched course ids), but every new deletion test passes `courseId`
  explicitly rather than trusting the default — a cascade test that accidentally shared a courseId
  with an unrelated fixture would be quietly wrong. Worth knowing before adding more cases.

## Phase 2 — repos

`src/ui/data/repos.ts` + `src/ui/data/repos.test.ts` only (plan item 6). `CoursesRepo` gains four
queued members (`deleteCourse`, `resumePendingDeletions`, `importAll`, `exportAll`) and `SessionsRepo`
gains `deleteSession`; the module header now states the invariant in one place — every `courses.json`
read-merge-write in the app goes through `CoursesRepo.enqueueWrite`. 35 tests green; `tsc -b --force`
and `eslint` clean.

### Assumptions

- **`deleteCourse` returns `boolean`, not `DeleteCourseResult`** (the plan's signature). The
  `sessionsDeleted` count is therefore dropped at the repo boundary. That is fine for item 9's failure
  copy (*"Deleted 7 of 12 sessions"*): on failure the storage **rejects**, so no count exists to report
  anyway — the confirm screen has to state the blast radius from the counts it already loaded, and
  compare against the repos after the reload. If a later screen genuinely needs the success count, the
  signature has to widen to `Promise<DeleteCourseResult | null>`.
- **`resumePendingDeletions` does NOT catch.** The seam contract says `storage.resumePendingDeletions()`
  never rejects (it runs at startup with nobody to retry it), and `resumePendingDeletionsFromStorage`
  enforces that in shared code. Adding a repo-level catch would be a second, untested home for an
  invariant that already has one; a rejection here is a bug in a `Storage` implementation, not a
  condition to swallow. (Consequence: `failingStorage` — where *every* member rejects — would reject out
  of this method. No test relies on that, and no real implementation does it.)
- **`exportAll` clears `lastError` on success.** It is the one queued read that sets `lastError` on
  failure, and every other op in these classes that can set it also clears it on success ("lastError is
  not sticky" is pinned by an existing test). The alternative — leave it alone, since an export writes
  nothing — would make a successful export the only success in the file that cannot clear a stale
  banner.
- **On a failed `deleteCourse` / `importAll` the reload runs BEFORE `lastError` is recorded**, because
  `reload()` clears `lastError` on success and the operation's own failure is the one worth surfacing.
  If the reload *also* fails, its error is overwritten by the operation's — deliberate: the user asked
  for the delete/import, not for the reload.
- **`SessionsRepo.deleteSession` filters rather than mutating in place**, matching `saveSession`'s `map`
  — the reactive mirror in `storage-context.svelte.ts` re-reads `snapshot`, and a fresh array reference
  is what the existing code produces.

### Test notes

- Every `reload()` added is **pinned by mutation**: removing the one in `resumePendingDeletions` fails 2
  tests, `deleteCourse`'s success-path reload fails 4, its failure-path reload fails 1, `importAll`'s
  success-path reload fails 1 and its failure-path reload fails 1, and dropping `lastError` from
  `SessionsRepo.deleteSession` fails 1. None of them is decoration.
- The failure-path reloads are driven by doubles that **land a partial write and then throw** (a cascade
  that dies after its INTENT write; an import that dies between the course write-back and the first
  session write), not by an all-rejecting storage — an all-rejecting double cannot tell a missing reload
  from a present one, because its `reload()` fails too.
- The resume tests seed the interrupted state through
  `storage.saveCourses({ …, settings: { pendingCourseDeletions: [...] } })`, per the plan.

### Noticed, out of scope

- **`Home.svelte:94` still calls `context.storage.importAll(...)` directly and `export-action.ts:30`
  still calls `exportAllToBlob(context.storage)`** → `storage.exportAll()`. Both bypass the queue, so
  the two new members are currently unreachable dead code. Wiring them (and mirroring the five
  signatures into `CoursesRepoView` / `SessionsRepoView`) is the next agent's task, as scoped —
  `exportAllToBlob` will need to take an envelope-producer rather than a `Storage`, per this file's
  pre-implementation assumption.
- `CoursesRepo` now has both `courses.json` *and* export/import responsibilities, which stretches its
  name a little. Not renamed: it owns the document, and the document is what has to be serialized.

## Phase 2 — context wiring

Wiring the five new repo members through the views, App, Home and the export flow (plan items 6, 10 and
item 5's export-integrity paragraph). No new screens or routes.

### Decisions

- **`exportAllToBlob(storage)` became `exportEnvelopeToBlob(envelope)`** — synchronous, taking the
  envelope rather than a producer. The plan allows either; the envelope wins because `runExport` has to
  hold it anyway to check the repo's `null` failure return, so a producer would add a callback and no
  information. Renamed rather than kept: the old name promised it would call `Storage.exportAll`, which
  is now precisely what it must not do. `src/core/storage/export.ts` no longer imports `Storage` at all.
- **`runExport`'s failure message on a `null` envelope** is `coursesRepo.lastError.message`, falling back
  to "the export could not be assembled" (`exportOutcomeNotice` prefixes "Export failed: "). The fallback
  is unreachable today — `CoursesRepo.exportAll` always records `lastError` before returning `null` — but
  the view's type is `RepoError | null` and this is the honest reading of it.
- **`importAll` is delegated plainly** in `storage-context.svelte.ts`, unlike `deleteCourse` /
  `resumePendingDeletions` which compose `sessionsRepo.refresh()`. It writes session files too, so the
  invalidation rule applies — but its only caller (`Home.importFile`) already refreshes through
  `loadStats()`, which it must call anyway to recompute the card records, and a refresh inside the view
  would make that a second full session scan per import. The rule is documented on the view member
  instead. Revisit if a second caller appears.
- **Home's import-failure copy is one function over `{ kind, message }`**, fed by both the thrown
  `StorageError` from `parseImportFile` and the `RepoError` behind the repo's `null`. A failed *merge*
  (as opposed to a failed parse) now shows both the import notice and Home's standing
  "Storage error: …" line, because `CoursesRepo.importAll` sets `lastError`. Accepted: the storage
  condition is real and app-wide, and both existing failure tests are parse-time (no `lastError`).
- **The two app-level notice channels share one CSS class**, renamed `.quarantine` → `.appnotice` in
  `App.svelte`. The resume copy lives inline in `App.svelte` rather than in `delete-copy.ts` (item 9,
  a later agent's file) — App is its only consumer, and the module does not exist yet.

### Assumptions

- **The startup resume is fire-and-forget and unawaited by anything.** `createStorageContext` stays
  synchronous (`App.svelte:43` constructs it during setup), so screens can render — and a pilot can arm a
  flight — while the resume is still in the queue. That is safe *because* it is queued: a `saveCourse` or
  `updateSettings` racing it lands after it, against the reloaded snapshot.
- **`deletionNotices` accumulates, never clears itself.** The resume runs once per context, so the list is
  at most one notice per pending marker, dismissed individually. Same lifetime as `quarantineNotices`.

### Test notes

- `storage-status.browser.test.ts` gains the two resume-notice tests (its existing quarantine-notice test
  is the sibling idiom). The `completed` one mounts on `#/diag` — a route that never touches the storage
  context — to pin the item-10 decision that the notice belongs to `App`, not `Home`.
- `export-action.test.ts`'s failure test now asserts `storage.exportAll` is **never called**: the repo is
  the only door.

### Noticed, out of scope

- `Storage.exportAll` is still reachable from any UI module that holds `context.storage` — the seam is a
  convention plus these two comments, not a lint rule. `eslint.config.js` bans OPFS *syntax* outside
  `src/core/storage/**`, not `Storage` members outside `repos.ts`; a rule banning
  `context.storage.<queued member>` in `src/ui/**` would make the critical section structural. Not built:
  it is a new lint seam, and this task's scope was the wiring.

## Phase 3 — discard icon

Item 11, `FlyArmedPanel` half. `FlyArmedPanel.svelte:126`'s trash glyph
(`M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14`) is replaced by a struck-through mark: a rounded rect
(`x=4 y=7 w=16 h=10 rx=3`) with a horizontal line `M2 12h20` running through it and overhanging
both edges. Same `.ic` idiom (stroke `currentColor`, 24x24, round caps).

### Assumptions

- **A struck-through *shape* beats a crossed-out circle.** A circle with a diagonal is the
  prohibition sign (⊘) and reads as "forbidden", which discard is not. The rect-with-a-line
  mirrors the app's own existing vocabulary for a discarded lap: `.discarded` in `LapTable` and
  in this panel's own stat grid is `text-decoration: line-through`. The icon now says the same
  thing the row it produces says.
- The overhang (line from x=2 to x=22, rect from x=4 to x=20) is what makes it read as *struck
  through* rather than a divided box; without it, the glyph looks like a minus in a frame.
- **No test needed updating.** Nothing asserts the path data; `fly.browser.test.ts:324` and
  `e2e.browser.test.ts:196` both select the control with `buttonByText('Discard last lap')`, and
  the `__screenshots__/` PNGs are vitest failure captures, not asserted snapshots.
- Behaviour, label, `btn btn-ghost discard` classes, disabled logic and position are untouched.
  Discard stays instant and unconfirmed by design (plan, "Discard != delete").

### Open questions

- `docs/mockups/ui-mockups.html:688` still carries the same trash glyph on this button. Out of
  scope here (item 12 owns the mockups), but the mockups are the design source of truth, so the
  two will disagree until that item lands. Flagging so it is not missed.

## Phase 3 — routes

### Decisions

- **Variant names follow the existing verb-first pair** (`new-course`, `edit-course`): the new variants are
  `{ id: 'delete-course'; courseId }` and `{ id: 'delete-session'; sessionId }`, hashes
  `#/course/<id>/delete` and `#/session/<id>/delete`.
- **`new` is reserved against `delete` exactly as it is against `edit`.** The two three-segment course forms
  now share one `segments[1] !== 'new'` guard, so `#/course/new/delete` falls through to `HOME` like any other
  malformed hash. Restructured the `course` case from a single flat condition into that shared guard plus an
  inner `edit`/`delete` discrimination — the alternative (repeating `&& segments[1] !== 'new'` per verb) makes
  the reservation a rule you can forget to copy the next time a verb is added.

### Assumptions

- **No id is reserved on the session side.** There is no `#/session/new` form, so `#/session/new/delete` parses
  as a delete of a session whose id is literally `new` — harmless, since ids are `crypto.randomUUID()` and the
  screen's not-found branch is the safety net. If a `#/session/new` form ever lands, the reservation must land
  with it.
- **`isGateExempt` stays false for both**, i.e. the confirmation screens are behind the capability gate like
  every other product route. Asserted in the existing enumeration test.

### Noticed, out of scope

- `App.svelte`'s route chain ends in an `{:else}` fallback (`src/ui/App.svelte:114`), so widening the union does
  **not** break `tsc -b` — but it also means both new routes silently render the fallback until the screens are
  wired (item 8). No exhaustiveness error to report; the compiler will not catch a forgotten branch here.

## Phase 3 — delete copy

`src/ui/screens/delete-copy.ts` + `delete-copy.test.ts` (item 9). Pure copy functions only; the screens
(item 8) consume them.

### Discrepancy: the plan's session-body example is not what `formatDateTime` produces

Item 9 spells the session body as *Sunday 12 Jul, 14:30 — 28 laps, best 14.32 s.* The real
`formatDateTime` (`src/ui/fly/fly-format.ts:31`) renders `2026-07-12 14:30` — ISO-ish, no weekday, no
month name. Per instruction the REAL formatter wins, so the shipped copy is
`2026-07-12 14:30 — 28 laps, best 14.32 s. It cannot be undone.` and the tests pin that. Nothing was
changed in `fly-format.ts`: it is the same string the session header already shows, so the confirm
screen names the session the way the rest of the app does. If the weekday form is actually wanted, it is
a change to `formatDateTime` (and to every screen that uses it), not to this module.

`formatLapSeconds` returns a bare `14.32`; the ` s` unit is appended here, matching `rec-format.ts`.

### Assumptions

- **Counts-unavailable is `null`, not a zero-filled record.** `deleteCourseBody(null)` /
  `deleteCourseConfirmLabel(null)` produce the count-free copy. The screen must pass `null` while the
  sessions repo is still loading or has `lastError` — passing `{sessionCount: 0}` there is the exact bug
  item 8 calls out.
- **`deleteExportNotice` takes a `subject: 'course' | 'session'`.** Item 9 gives the delivered copy as
  "…restores this course", but the export escape hatch sits on both delete screens, and telling a pilot
  deleting a session that the file "restores this course" is a non-sequitur. The `'course'` branch is the
  plan's string verbatim; `'session'` swaps the final noun. Failure/cancellation delegate to
  `exportOutcomeNotice`, so that copy stays in one place.
- **Failure copy takes `{sessionsDeleted, sessionsDoomed}`.** `deleteCourse` only returns
  `DeleteCourseResult` on success, so a screen must derive `sessionsDeleted` itself (doomed count minus
  what a post-failure refresh still lists). No session-delete failure copy: a single-file delete has no
  partial state to describe — the screen's `lastError` says it.
- **No `Cancel` constant.** It is a literal on the screens; not worth a module boundary.
- Lap counts everywhere are ALL laps, valid + discarded (a discarded lap keeps every byte and rides in
  the export). `SessionSummary` carries both `lapCount` and `validLapCount`; the screens must pass
  `lapCount`.

## Phase 3 — danger triggers

`CourseForm.svelte`, `SessionView.svelte` (+ their existing browser tests).

### Assumptions

- **Read-only renders a `disabled <button>`, not nothing.** An `<a>` cannot be disabled, and the
  navigation-as-CTA pattern the plan points at (`CourseView`'s `a.btn.btn-primary.start`) is an anchor.
  Both screens therefore branch: anchor when writable, `<button class="btn btn-danger-ghost" disabled>`
  with identical content when `context.readOnly`. Silently *not offering* delete on `SessionView` would
  be mute — that screen has no standing read-only banner, only the note controls' hint, which is hidden
  unless the note is dirty. The shared label+glyph lives in a `{#snippet deleteLabel()}` per file.
- **The `CourseForm` danger section sits INSIDE `<form>`, after `.cta`.** `main.course-form` is a flex
  column with `min-height: calc(100dvh - 5.5rem)` and `.cta { margin-top: auto }` pins the Save button
  to the viewport bottom *from inside the form*. A sibling after `</form>` would land below the fold on
  every phone. Inside the form, `margin-top: auto` pushes the CTA + danger group together, so the rule
  and Delete sit at the bottom as the mockup's 02b shows. The trigger is an `<a>` (never submits); the
  read-only fallback is `type="button"`.
- **`SessionView`'s danger block gets `max-width: 24rem` at the 48rem breakpoint**, matching the header
  column. `.btn` is `width: 100%` and `main` widens to 64rem on desktop — a 64rem-wide delete button
  would shout louder than anything else on the page.
- The trash glyph (`M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14`) is inlined in both screens with the existing
  `.ic` stroke-SVG idiom. `FlyArmedPanel`'s strike-through swap had already landed when this was written.
- No `deleting` state on either screen: the confirmation is a route, so these components are unmounted
  during the delete and only ever navigate.

## Phase 3 — delete screens

`DeleteCourse.svelte`, `DeleteSession.svelte`, their two `App.svelte` route branches, `.btn-danger-ghost`
in the global button block, and `delete-screens.browser.test.ts`.

### The load gate (item 8 [R2])

`DeleteCourse` calls `sessionsRepo.refresh()` on mount — never `ensureLoaded()`, which would trust a
cached list that a flight has already outdated — and holds a local `sessionsSettled` flag. Counts are
derived only when `sessionsSettled && sessionsRepo.lastError === null`; until then the blast radius is
`null` (count-free copy, no backup warning suppressed) and the Delete button is disabled. The unloaded
repo's null `lastError` is therefore never read as "no sessions": the flag, not the error channel, is
what says the repo answered. `sessionCount` is the number of summaries; `lapCount` sums
`summary.lapCount` (all laps, valid + discarded) — zero session-body loads.

When the refresh fails, the button stays disabled for good and the screen says why
("The sessions on this course could not be counted: …"). Deleting a course whose blast radius we cannot
state is exactly what item 8 forbids, so there is no "delete anyway" affordance.

`DeleteSession` gates on `session !== null && coursesRepo.loaded` — the session for the counts (its
`bestLap` is not in `SessionSummary`), and the course list because an unloaded course repo is
indistinguishable from an orphan, and landing an orphan-bound delete on the wrong parent is the same
mistake in a smaller coat.

### Assumptions

- **The confirm-time freeze, not just a `deleting` flag.** Item 8's flash guard is stated for the
  not-found branch, but the same reactive vanish rewrites the title, the body and the button label:
  `deleteCourse` commits, `onChange` fires, and both the course AND its session summaries leave the
  snapshots while `location.replace()` is still a later task. `DeleteCourse` therefore freezes
  `{courseName, blastRadius}` into `$state` at confirm time and renders from that; the not-found branch
  is gated on `confirmed === null` (a superset of `deleting` — it also holds after a failure, when the
  cascade may have committed the course away and the screen must stay put). `DeleteSession` needs none of
  this: its `session` is a one-shot `$state` from `loadSession`, so nothing it renders can be emptied by
  the delete — verified, not assumed.
- **The failure notice does not re-refresh the sessions repo.** The plan says to refresh after the
  failure and subtract; `context.coursesRepo.deleteCourse` (storage-context.svelte.ts) already refreshes
  `sessionsRepo` on BOTH outcomes, so the summaries are current the moment it resolves. Adding a second
  `listSessions()` scan on the error path would be a duplicate of the composition point's, and if that
  composition ever stops refreshing, `SessionsRepo`'s stale-summary bug is app-wide, not this screen's.
  `sessionsDoomed` stays the count the confirmation *promised* (frozen), so a retry that fails again says
  "Deleted 9 of 12" — cumulative against the original promise, not against a shrinking denominator.
- **Session-delete failure copy lives on the screen** ("Could not delete this session: …. Try again."),
  per the Phase 3 copy note that a single-file delete has no partial state for `delete-copy.ts` to
  describe.
- **Cancel is a `<button>`, not an anchor**, so it can be disabled while the delete is in flight. The
  AppBar's `backHref` is the same destination and is the free Back-gesture cancel.
- **The export escape hatch never gates the delete**: `runExport(context)` → `deleteExportNotice(outcome,
  subject)`, rendered inline. It does not auto-continue, and a failed export leaves the Delete button
  exactly as enabled as it was. It IS disabled while a delete runs, which is a busy-state, not a gate.
- **`.btn-danger-ghost` is defined but unused by these two screens** — it dresses the initiating controls
  on `CourseForm`/`SessionView` (a separate task). The filled `.btn-danger` stays reserved for the two
  confirm buttons and the armed STOP button.

### Out of scope, noted

`docs/mockups/ui-mockups.html` still has no screens 10/11 and no `.btn-danger-ghost` rule (item 12's
docs task). The screens are built from existing mockup tokens only (`.card`, `.btn`, `.notice-*`,
`.label`, `.stack`), so the mockup can be drawn from the shipped markup without redesigning anything.

---

## Phase 4 — mockups

`docs/mockups/ui-mockups.html` (item 12's mockup bullet). Three new screens, one corrected glyph, one
new button variant. No source, spec or ADR files touched.

### What went in

- **Screens 08 Edit course, 09 Delete course, 10 Delete session**, inserted after 07 Review; the
  unsupported-browser edge state renumbered 08 → 11 so it stays last (the gallery's convention: the
  flow, then the edge state). Inserting there kept the deletion story next to the screens it is
  reached from and renumbered exactly one existing screen.
- **`.btn-danger-ghost`** beside `.btn-danger`, verbatim from `App.svelte`, with a comment noting that
  the filled `.btn-danger` stays reserved for the confirm buttons and the armed STOP.
- **`.notice-warning`**, `.del*` and `.danger` rules — the mockup had no notice or delete vocabulary at
  all. `.notice-warning` mirrors `App.svelte`'s rule in the file's px idiom (8px/11px padding, 6px
  radius = the shipped 0.5rem/0.7rem/0.375rem).
- **The discard glyph on screen 06** swapped from the trash can to the shipped struck-through mark
  (`<rect x="4" y="7" width="16" height="10" rx="3"/><path d="M2 12h20"/>`, `FlyArmedPanel.svelte`),
  with a comment saying why: discard keeps every byte.
- **Screen 07 gained the Delete session danger section** (not in the task list, but the mockups' silence
  about the *entry points* is the gap this phase exists to close — and `SessionView.svelte` ships it).
  Tightened to `margin-top:14px;padding-top:14px` inline: the phone frame is a fixed 772 px with
  `overflow:hidden`, and the lap table leaves ~130 px of slack.
- **The legend's red swatch** now reads "destructive: stop, and delete (filled = the confirm, ghost =
  the way in)" — it said "stop (destructive, semantic only)", which is no longer the whole truth.

### Copy is verbatim from `delete-copy.ts`; the DATA is the gallery's, not the plan's

Every string is the shipped template: `Delete "Basement 3-gate"?`, `This also deletes N sessions and M
laps flown on this course. It cannot be undone.`, `Not backed up — some of this was flown after your
last export. An export file is the only way to get this back.`, `Export backup first`, `Cancel`,
`Delete course and N sessions`, `Delete this session?`, `<datetime> — N laps, best X.XX s. It cannot be
undone.`, `Delete session`.

The **numbers** deviate from the task's examples, deliberately. The task gave *12 sessions and 340 laps*
for Basement 3-gate — but screens 01 and 03 already say that course has **4 sessions**, and screen 03
lists them (8 + 24 + 9 + 15 = **56 laps**). The file's own footer promises "realistic data throughout",
so the blast radius reads `4 sessions and 56 laps` and the confirm button `Delete course and 4
sessions`. Same for the session body: `2026-07-11 20:12 — 8 laps, best 12.84 s.` is the session on
screen 07, in `formatDateTime`'s real format, rather than the plan's `2026-07-12 14:30 — 28 laps`.

### Shipped UI vs. the task description

- **The AppBar title is not the question.** The task described the confirm screen's AppBar title as
  `Delete "Basement 3-gate"?`. Shipped, `AppBar title="Delete course"` and the question is the `<h2>`
  below it (same for the session: bar `Delete session`, h2 `Delete this session?`). The mockups follow
  the shipped split.
- **`Export backup first` carries no icon** in the shipped screens, so it carries none here, even though
  the mockup has an export glyph in Home's app bar.
- Loading, not-found, read-only, export-notice and cascade-failure states are *not* drawn. They exist in
  the shipped screens; the gallery has never drawn per-state variants (it draws one canonical frame per
  screen), and drawing five more frames would drown the deletion story.

## Review fixes — the repo layer (`src/ui/data`)

Four findings against `repos.ts` / `storage-context*.ts`; all four applied, none disputed.

### A failed `reload()` now invalidates instead of preserving

`reload()` swallowed its error into `lastError` and left `coursesList` / `settingsData` in place with
`loaded` still `true`. After a *committed* cascade, one transient `loadCourses` failure (OPFS maps any
read exception to `corrupt`) therefore left the repo holding the deleted course — and the next
fire-and-forget `updateSettings` (`FlyFlow` writing `lastCourseId` on arming) wrote that stale document
back: the course resurrected, empty, its sessions genuinely destroyed, and the intent marker erased by
the same write. The catch arm now drops `loadedFlag` and clears `loadPromise`. `saveCourse` and
`updateSettings` already bail on `!loadedFlag`, so every write fails safe; load-once caches successes
only, so the next `ensureLoaded` retries the read. Screens gate their lists on `loaded` and render
`lastError` beside the loading line (Home does both), so the invalidated state is one the app already
models — the same one an initial load failure produces.

`deleteCourse` still resolves **true** when the cascade committed and only the reload failed. The course
*is* gone from disk; the failure copy ("the course is still here. Try again.") would be a lie, and the
storage error is on screen anyway.

### `reload()` stays outside the queue; a commit counter orders it

Queuing `reload()` deadlocks — queued writes `await ensureLoaded()` from *inside* the queue. So loads now
carry the commit count they started with and **discard their result if a write committed under them**
(`noteCommit()` fires in the same turn each storage write settles, on both outcomes, since a cascade or
import that threw can still have landed its first write). This closes the startup race the reviewer
named: `resumePendingDeletions` (queued) against Home's `ensureLoaded` (unqueued) — a load that read the
pre-resume document can no longer land after the resume's own reload and re-instate a resumed course or a
marker the resume abandoned.

Discarding cannot strand the repo: every op that bumps the counter either sets the snapshot itself
(`persist`) or reloads inside its own queued turn (`deleteCourse` / `importAll` /
`resumePendingDeletions`), so the fresher answer always arrives — and the snapshot a discard leaves in
place is by construction the newer one.

### One resume path

`CoursesRepoView.resumePendingDeletions` was dead code with a different post-condition from the real
startup call (it refreshed the sessions repo but never raised the deletion notices, so a future caller
would have resumed cascades silently). Deleted. The startup composition in `storage-context.svelte.ts` is
the only way in, and the interface now says so: resuming is a startup act with cross-cutting collateral
(session files gone behind `SessionsRepo`'s back, plus a notice the user must see), and a second entry
point is a second post-condition to forget.

### The journal is out of the settings door — and the narrowing is enough

`updateSettings` now takes `SettingsPatch = Partial<Omit<AppSettings, 'pendingCourseDeletions'>>`, pinned
by a `@ts-expect-error` in `repos.test.ts` (tsc typechecks `src/**/*.ts`). No screen can forge a work list
or clear a live marker whose sessions are already destroyed; the merge still carries the on-disk value
through untouched.

**Judged sufficient — the marker stays in `AppSettings` for now.** Moving it to a sibling key on
`CoursesData` would touch the schema, `parseSettings`, `delete.ts`, both Storage implementations and the
export envelope, for the same reachable guarantee: `CoursesRepo` is the only writer of `courses.json` in
the app, and the settings door was its only unguarded opening. What the type does not buy is defence
against `src/core/storage` writing the key incorrectly — but that is the code that *owns* it. Worth
revisiting if a second journal-like field ever needs the same treatment.

---

## Review fixes — docs (2026-07-14)

Doc/codebase-alignment findings, docs half. No disputes: all five were valid.

- **The mockups' delete screens now lay out like the shipped ones**, not the other way round. The
  mockup had `.del { flex: 1 }` + `.del .cta { margin-top: auto }` — the confirm CTA pinned to the
  viewport bottom, the `CourseForm` idiom — while `DeleteCourse`/`DeleteSession` flow it under the copy
  (`.cta { margin-top: 0.75rem }`). Aligned to the shipped flow rather than to the pin, and the reason is
  in the rule: a filled-red confirm parked on the thumb line is the reflex tap the confirm screen exists
  to prevent. The reach is the point. `.danger` likewise moved 24/18px → 32/24px (the shipped
  `2rem`/`1.5rem`), and the inline `margin-top:14px;padding-top:14px` tightening of screen 07's danger
  block — noted above as a phone-frame budget compression — was **removed**: a headless render of the
  gallery shows every phone frame at zero overflow with the full rule, so the compression was never
  needed and was pure drift.
- **ADR 0011 supplements 0010; it does not amend it.** The plan (item 12) instructed the ADR to state
  that it "amends ADR 0010's decision 3 and its amendment", on the grounds that the marker makes 0010's
  *"our writes create no artifacts of their own"* untrue. It does not: 0010's "artifacts" are **stray
  files** (its parenthetical enumerates `.crswap`, quarantine copies, non-`.json` names), and this phase
  creates none — the marker is a value inside a file we own and write. The ADR now says so, and
  `opfs-storage.ts`'s "there is deliberately NO startup sweep" stands unamended. **The plan's item 12
  wording is left as written** (it is the plan as it was executed); the ADR is the durable artifact and
  it is the one that is now right.
- Docs re-read against the code as the other fixers landed it, and three behaviours had no home in the
  spec: the export **strips** `pendingCourseDeletions` from the envelope; an import **abandons** every
  marker naming a course or session the file carries; the resume **condemns and releases** course ids
  through the shared cascade. All three are now in `storage.md` (and the import-abandons rule in
  `product.md` + ADR 0011 decision 5), because each is load-bearing for the claim the docs *already*
  made — that the export file is the only undo. A marker that rode out in the export, or survived a
  restore, would have the next launch finish the cascade over the data the pilot just put back.

## Review fixes — critical-section seam

**The finding.** `repos.ts`'s header asserts that *every* `courses.json` read-modify-write goes through
`CoursesRepo.enqueueWrite` — and nothing enforced it. `StorageContext.storage` was a public `Storage`
handed to every screen, so `context.storage.deleteCourse(…)` / `.saveCourses(…)` / `.importAll(…)` /
`.exportAll()` / `.resumePendingDeletions()` all compiled and linted clean. The proof the convention did
not hold on its own is this feature's own history: `Home.svelte` called `context.storage.importAll` and
`export-action.ts` called `storage.exportAll` — both violations of an invariant that was *already written
down*, both fixed only because this phase went looking. Three later safety mechanisms then piled onto the
same unenforced premise: `noteCommit()`'s generation counter, the invalidating `reload()`, and the
justification for leaving the deletion journal inside `AppSettings` ("CoursesRepo is the only writer of
courses.json in the app"). One call the compiler permits re-opens the resurrection bug.

**Both options were built, and both were needed.** Option (a) alone closes it for today's product code but
leaves the door re-openable; option (b) alone leaves the handle lying on the floor. They also cover each
other's gaps: (a) is a type boundary, so a `as unknown as` cast walks through it; (b) is a syntax rule, so
an alias (`const s = storage`) walks through *it*. Seeding the historical `export-action` violation
*through a cast* still failed lint — which is the case for keeping both.

**(a) The boundary, narrowed.** `StorageContext.storage` is gone. Product code touched it in exactly three
places, and none of them wanted a `Storage`:

- `FlyFlow.svelte` passed it to `createFlySession` → `createSessionPersister`, which calls **`saveSession`
  and nothing else**. So `session-persister.ts` now names that narrow: `export type SessionWriter =
  Pick<Storage, 'saveSession'>`, `createSessionPersister` takes it, `FlySessionOptions.storage` takes it,
  and the context exposes `sessionWriter`. `saveSession` is deliberately *not* a queued member — it writes
  one session file atomically and never touches `courses.json`.
- `FlyFlow.svelte` and `export-action.ts` used it for the structural read-only probe. That is a
  *capability question*, not a handle, so it became `context.liveReadOnly()`. `storageReadOnly()` stopped
  being exported from `storage-context.ts` and moved into `storage-context.svelte.ts` beside
  `disposeStorage()`, the other structural probe. FlyFlow's old fallback (`?? context.readOnly`) was dead:
  `context.readOnly` is itself a mirror of `storageReadOnly(storage)`, so the fallback could only ever
  return the same answer, one refresh staler.

The queued members are now **unreachable** from every screen — not by convention, by type.

**(b) The lint seam,** `eslint.config.js`, in two layers, self-tested in `lint-seams.test.ts` (43 new cases):

1. `seam/storage-handle-only-in-the-data-layer` — `no-restricted-imports`, `importNames`-scoped: nothing
   under `src/ui/**` may **name** `Storage`, `OpfsStorage` or `MemoryStorage` except the two files that
   legitimately hold a handle (`data/repos.ts`, `data/storage-context.svelte.ts`). Re-widening
   `StorageContext` back to `readonly storage: Storage` therefore fails CI **at the import line**, before
   there is anything to call. Scoped by import *name*, not by module: `SessionSummary`, `ImportResult`,
   `isStorageError` and friends stay open to the screens — banning the module wholesale would have been the
   lazy version of this.
2. `seam/courses-json-critical-section` — `no-restricted-syntax` over the six queued members
   (`saveCourses`, `deleteCourse`, `deleteSession`, `importAll`, `exportAll`, `resumePendingDeletions`),
   everywhere in `src/ui/**` except `repos.ts`.

**The selector had to discriminate on the handle, not the method name** — the one real design constraint
here, and the OPFS seam's `remove`/`element.remove()` lesson in a nastier form. `CoursesRepoView`
deliberately exposes `deleteCourse` / `importAll` / `exportAll`, `SessionsRepoView` exposes
`deleteSession`, and `storage-context.svelte.ts` calls `coursesRepo.resumePendingDeletions()` on the repo
class. A bare-name ban would fire on **every sanctioned door in the app** — including the Delete screens
this phase just built. So the ban targets the two static shapes a `Storage` handle actually takes here: a
binding named `storage` (`storage.exportAll()`) and a `.storage` property (`context.storage.importAll()`,
`this.storage.saveCourses()`) — which are, precisely, the two forms that shipped as violations. Both
negative cases are pinned: the repo views keep their names, and `repos.ts` keeps its `this.storage.*` calls.

**Declared gap, same as the OPFS seam's:** an alias or a dynamic key evades layer 2. That is a guardrail
against accidental bypass, not an adversarial boundary — and layer 1 is what makes the alias hard to
*obtain*. Pinned as a passing test so nobody "fixes" it later thinking it is a bug.

Flat config replaces rather than merges, so the new `src/ui/**` syntax block re-applies the OPFS and
WebCodecs bans alongside its own; `repos.ts`, exempt from the new block, falls back to the combined one and
keeps both. Pinned by test.

**Widened for tests, and why it is safe.** Test files were already allowlisted from the seams, and the two
that reached through `context.storage` now keep their own handle instead: `backup-nudge.browser.test.ts`'s
`seededContext` returns `{ context, storage }` (it constructed the `MemoryStorage` itself — it just was not
holding onto it), and `export-action.test.ts` drops the `storage.exportAll` spy entirely. That spy is worth
a word: it existed to assert `runExport` does *not* call the wrong door — a test that could only ever catch
the mistake *after* somebody made it. The wrong door is now a compile error and a lint error, so the test
keeps the behaviour assertion and sheds the surveillance.

**`CoursesRepoView.reload()` removed** (flagged as dead surface). Nothing called it — no screen, and
`repos.test.ts` calls `reload()` on the repo *class*, not the view. It was also the one view member that
could drop `loaded` to false on failure, which is a footgun to leave lying around for a caller that does not
exist. `CoursesRepo.reload()` itself is untouched: the repo calls it from inside its own queued ops.

**Proof the guard works.** Seeded, confirmed, reverted:
- A probe file with all six members via bare-handle, `.storage`-property, computed and destructuring forms,
  plus `Storage` and `MemoryStorage` imports → **8 lint errors**, one per violation.
- The *historical* `export-action.ts` violation (`context.storage.exportAll()`), written with an
  `as unknown as` cast so it typechecks → **still errors** (`no-restricted-syntax`).
- The *regression* this exists to catch — `readonly storage: Storage` put back on `StorageContext` →
  **errors at the import line** (`no-restricted-imports`).
After revert: `bun run lint` clean, `bun run test:browser` 126/126, `bun run test` green except
`src/core/storage/delete.test.ts` (a concurrently-in-flight `DeleteTarget` change, untouched by this work).

## Review fixes — guard over-correction

The previous fix moved `condemnCourse`/`releaseCourse` into the shared cascade and condemned **before**
the read-before-destroy scan. That closed a ghost hole and opened two worse ones, because the guard's
*destructive* half (`removeResurrectedFile`) now fired on behalf of a deletion that had **not committed
and might never commit**.

**The root cause, stated once:** condemning and destroying were the same authority. They are not.
A deletion in flight has destroyed nothing — it can still die on its INTENT write with quota, or be
abandoned by the resume's flown-since rule. It may **refuse** a write; it may not **take bytes back**.

### What changed

1. **Three guard calls, not two** (`DeleteTarget`, both implementations):
   - `condemnCourse` — deletion in flight. **Refuse only** (`condemnedCourseIds`).
   - `releaseCourse` — it did not commit; the course stands and must be flyable again.
   - `commitCourseDeletion` — the COMMIT write landed (`deletedCourseIds`). *Only now* may a session
     file of this course be removed rather than merely refused. Never released.

   `saveSession`'s pre-check consults all three sets (`isRefused`); its post-write compensation
   consults only the two that record a destruction that **actually happened** (`wasDestroyed`:
   `deletedSessionIds` ∪ committed `deletedCourseIds`).

2. **Reads before the condemn**, in both `deleteCourseFromStorage` and `resumeOne`. The scans take
   seconds on a real store; a deletion that has committed to nothing must not lock the pilot out while
   it is only *looking*.

3. **The resume re-scans after condemning.** A scan reads a snapshot — OPFS collects the directory's
   names first and reads the bodies afterwards, so a session file created mid-scan is on disk but
   invisible to that scan's result. Without the re-check, moving the condemn later would have merely
   *moved* BUG 1(a): the arm would land, the single scan would miss it, the resume would complete, and
   the post-commit sweep would erase the flight. The re-check runs once the condemn has made the answer
   stable, so it is the last word.

4. **A post-commit sweep** (`sweepAfterCommit`): commit the flag, re-list, remove any session still
   naming the course. This is what forbids the ghost state now that a condemned course cannot destroy.
   It is deliberately *after* the COMMIT: pre-commit the course may yet be standing.

### Judgment calls

- **Why a third guard state rather than the reviewer's two-set + sweep.** The minimal direction (limit
  `removeResurrectedFile` to `deletedSessionIds`, sweep after commit) leaves invariant 3 with a real
  hole: a write for a *never-on-disk* session whose bytes land **after** the sweep's name-collection is
  named by no session id and found by no scan — permanent ghost. `commitCourseDeletion` closes it: the
  sweep catches everything that landed before it, the committed flag catches everything whose post-write
  check runs after it, and the two overlap with no gap because the flag is raised *before* the sweep
  scans. Cost: one method on the seam.
- **Three full scans on the resume path** (stray check, re-check, sweep) and two on `deleteCourse`.
  Accepted: the resume only runs when a marker exists, and correctness of a destructive path beats an
  optimisation on a rare recovery path. A ledger of refused/landed write ids would avoid the scans but
  adds cross-layer state for a window measured in milliseconds.
- **`sessionsDeleted` now counts swept sessions too** (`doomed.length + swept`). Normally zero. Saying
  "12" when 13 were destroyed would be the dishonest option, and the field exists to be able to
  contradict the confirmation screen.
- **A post-commit sweep failure propagates** rather than being swallowed. For `deleteCourse` the user
  sees it and retry is safe (idempotent — a re-delete of a gone course still sweeps sessions naming it).
  For the resume it costs the notice, not the data; `resumePendingDeletionsFromStorage` still never
  rejects.

### Tests re-aimed (not deleted)

- `delete.test.ts` "writes the INTENT marker … before removing any session file" → **"reads, THEN
  condemns, THEN writes INTENT — and only commits the destructive guard after COMMIT"**. It pinned
  `condemn` as the first call; that ordering *is* the bug. The `DeleteTarget` fixture now logs reads and
  the commit call, so both orderings are visible in the log rather than invisible in the end state.
- `delete.test.ts` "CONDEMNS the course before its scan" → **"SCANS FOR STRAYS BEFORE CONDEMNING,
  re-scans after, and only then deletes"**. This is the assertion that encoded BUG 1(a) most directly.
- `delete.test.ts` "touches nothing when loadCourses rejects" now asserts an **empty** call log: a
  cascade that cannot read must not so much as refuse a pilot's write. (It previously expected
  `condemn` + `release`.)
- `storage-contract.ts` "the guard is armed before the sweep, not after" → **"…before the session files
  go, not after"**, with a note that it must *not* be read as licensing a condemn before the reads.
  Its assertions are unchanged and still hold.
- `opfs-storage.test.ts` "a completed resume condemns the course: a session armed while it ran cannot
  land" → **"…a session armed for it after the commit cannot land"**: it always armed *after* the resume
  resolved, and its comment claimed the opposite of what is now correct.

### New tests (each verified non-vacuous by breaking the mechanism)

| Break | Failures |
|---|---|
| condemn moved before the reads (the bug) | 9 — all three new contract cases on **both** implementations, plus the three re-aimed ordering tests |
| post-commit sweep removed | 5 |
| `removeResurrectedFile` back on `isRefused` | 1 (the OPFS in-flight-write case) |
| resume's post-condemn re-scan removed | 4 |

Contract suite (runs against MemoryStorage in node *and* real Chromium OPFS):
- *a session armed while the resume is scanning ABANDONS the deletion* — BUG 1(a). Models the scan
  honestly: summaries are computed, then the arm lands, then the stale summaries come back.
- *a cascade that fails at its INTENT write destroys nothing* — BUG 2, refusal half.
- *no readable session file outlives its course: one that landed mid-scan is swept after the COMMIT* —
  invariant 3, now via the sweep.

`opfs-storage.test.ts` adds *does not compensate a write that raced a cascade which then FAILED* — BUG 2's
destructive half, which only the real (asynchronous) implementation has: the persister's write parks
inside `writeTextFile`, commits while the course is condemned-but-uncommitted, and **keeps its bytes**.
