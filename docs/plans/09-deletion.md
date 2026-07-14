# Phase 9 — Deleting courses and sessions

> **Revision 2 (2026-07-14):** revision 1 was adversarially reviewed against the code; 39 findings
> survived independent verification. Four were serious enough to change the design and are called out
> inline as **[R2]**. The intent marker in particular was unsafe as first specified — it re-derived
> its work list at resume time, making it an *unbounded standing instruction*.

## Goal

A pilot can delete a session, and delete a course (which takes its sessions with it), from the
product UI — deliberately, never by accident, with the blast radius stated before the fact and an
honest word about whether it is backed up. A deletion interrupted by a crash completes itself on the
next launch instead of leaving a course whose session count lies.

This reverses `product.md` line 9 ("Deleting is out of scope for this spec revision except discarding
laps"), which is the sentence this phase exists to retire.

## Scope

**In:** two `Storage` methods and the shared cascade behind them; the two-phase intent marker that
makes an interrupted cascade recoverable; two confirmation screens and their routes; danger controls
on the course edit form and the session view; the honest not-backed-up warning and an export escape
hatch; docs (`product.md`, `storage.md`, ADR 0011, the mockups).

**Also in, because deletion upgrades their blast radius from a nuisance to a resurrection:** routing
`importAll` **and `exportAll`** through `CoursesRepo`'s critical section (item 6); splitting
`hasUnexportedSessions` out of `shouldNudgeBackup` (item 5); and making a strict export fail rather
than silently skip a session file that vanishes mid-scan (item 5).

**Out (v1 non-goals):** delete-lap and un-discard (discard already exists and is a different thing);
trash / soft-delete / undo; persisted tombstones and cross-device delete propagation (they belong to
sync, an explicit CLAUDE.md non-goal); a quarantine-file manager.

## Decisions taken (round table 2026-07-13, revised after review 2026-07-14)

**Cascade, not orphaning.** Deleting a course deletes every session whose `courseId` matches.
Orphaning them is a ghost bug shipped deliberately: no screen would ever list those sessions again
(Home renders only `repo.courses`, and `CourseView` filters by `courseId`), while
`OpfsStorage.exportAll` → `loadAllSessions('strict')` has no such filter — so they would ride in every
export and return as "Unknown course" on every import. The existing orphan concept (`storage.md`)
stays what it was meant to be: an import-only tolerance.

**Discard ≠ delete.** `discardLastLap` marks a lap `status: 'discarded'`. The lap keeps every byte: it
stays in the file, in the lap table (struck through) and in the export. It is a timing-correctness
annotation, stays instant and unconfirmed, and must stop sharing an icon with destruction (item 11).

**The export file is the only undo.** Re-importing a pre-delete export brings the data back, and that
is the restore path, not a bug — pinned as an intended contract test. Tombstones would make
`importIntoStorage` silently drop sessions the user just handed it, on the exact phone→desktop path
`storage.md` calls the v1 cross-device story.

**Confirmation is a screen, not a modal.** The app has no modal vocabulary and neither do the mockups;
routes are its navigation vocabulary (ADR 0007). A confirm screen gets Back-to-cancel for free, and the
screen transition breaks the reflex-tap rhythm that makes in-place confirms unsafe under a cold thumb.

**[R2] The intent marker is a bounded work list, not an instruction to "delete course X".** It captures
the exact session ids at confirm time. A resume may only ever remove ids on that list — never a set
re-derived from live data. See item 1.

## Work items (dependency order)

### 1. Schema: the intent marker — **[R2] redesigned**

```ts
export interface PendingCourseDeletion {
  courseId: string
  // Captured at step 1, while the course entry is still present, so a resume can
  // name it in the notice without depending on the course still existing.
  courseName: string
  // THE BOUNDED WORK LIST: exactly the sessions the user saw counted and confirmed.
  // A resume deletes these ids and nothing else.
  sessionIds: string[]
}

export interface AppSettings {
  speechEnabled: boolean
  lastExportAt?: IsoDateString
  lastCourseId?: string
  pendingCourseDeletions?: PendingCourseDeletion[]   // absent when nothing is pending
}
```

**Why bounded.** Revision 1 had the resume re-derive the doomed set by filtering live sessions on
`courseId`. That turns an abandoned deletion into a standing instruction: fail a delete, walk away,
fly the course for another month, and the next launch sweeps up sessions that did not exist when you
confirmed. Capturing the ids at confirm time makes the marker describe *work*, not *intent*, and caps
its blast radius at what the confirmation screen actually showed you.

**[R2] `parseSettings` must be extended to read the key.** `schema.ts:205` builds a fresh object from
known keys and drops unknown ones — so without this the marker would be written to disk and dropped on
every read, and the entire crash-recovery mechanism would be inert dead code. (Revision 1 cited that
exact behaviour as proof no migration was needed, and then forgot to parse the key.) Validate it
strictly: array of objects with a non-empty `courseId`, a string `courseName`, and a string array
`sessionIds`.

Still **no `SCHEMA_VERSION` bump**: an added optional key is forward-compatible on read, and an older
app drops it on its next write — degrading to the un-marked partial state, which fails safe.

### 2. The seam — `src/core/storage/storage.ts`

```ts
export interface DeleteCourseResult {
  sessionsDeleted: number
}

export type ResumeOutcome =
  | { kind: 'completed'; courseId: string; courseName: string; sessionsDeleted: number }
  // The course was flown again after the interrupted deletion: sessions exist that
  // the user never confirmed deleting. The deletion is ABANDONED and the marker
  // cleared — we never destroy data the confirmation screen did not count.
  | { kind: 'abandoned'; courseId: string; courseName: string; reason: 'flown-since' }

export interface Storage {
  // …existing 9 members…

  // Removes the session's file. IDEMPOTENT: an unknown id RESOLVES — never rejects
  // 'not-found', so a double-tap and a retry after a partial cascade are both safe.
  // Byte-level by filename: the document is never read, so a corrupt or
  // unsupported-version session is removed if its id is known. Quarantine copies
  // (<id>.json.corrupt.<ts>) are never touched.
  deleteSession(id: string): Promise<void>

  // Deletes the course AND every session whose courseId === id, clearing
  // settings.lastCourseId in the same write when it pointed here.
  //
  // TWO-PHASE, because ADR 0010 gives per-file atomicity only:
  //   1. write courses.json: course still present, marker += {courseId, courseName,
  //      sessionIds}                                                        [INTENT]
  //   2. remove those session files
  //   3. re-read courses.json, write it back without the course and without the
  //      marker                                                             [COMMIT]
  // Every read that can reject runs before step 1 (loadCourses can throw
  // 'unsupported-version'; discovering that after the files are gone would strand
  // condemned data in a state no retry can finish).
  //
  // Idempotent: an unknown course id still sweeps sessions referencing it.
  deleteCourse(id: string): Promise<DeleteCourseResult>

  // Finishes (or abandons) any cascade interrupted between steps 1 and 3. Resolves
  // [] on a read-only instance and when nothing is pending. NEVER REJECTS: a failed
  // resume leaves the marker in place for the next launch.
  resumePendingDeletions(): Promise<ResumeOutcome[]>
}
```

No new `StorageErrorKind` — deletion is a write (`write-failed` / `quota-exceeded`). A read-only tab
rejects `write-failed` through the existing `guardWriter()`, which is the *real* guard:
`context.readOnly` is false for up to `LOCK_RETRY_DELAY_MS` while the lock request settles, so the UI's
`disabled` is cosmetic.

### 3. The shared cascade — new `src/core/storage/delete.ts`

Mirrors `importIntoStorage` (`import.ts`), so the ordering invariant is the same code in both
implementations and cannot drift.

```ts
export async function deleteCourseFromStorage(
  target: DeleteTarget,
  courseId: string,
): Promise<DeleteCourseResult> {
  const existing = await target.loadCourses()            // read-before-destroy
  const course = existing.courses.find((c) => c.id === courseId)
  const doomed = (await target.listSessions())
    .filter((s) => s.courseId === courseId)
    .map((s) => s.id)

  const pending: PendingCourseDeletion = {
    courseId,
    courseName: course?.name ?? 'Unknown course',       // [R2] idempotent re-delete of a gone course
    sessionIds: doomed,
  }
  await target.saveCourses(withPending(existing, pending))            // 1. INTENT
  for (const id of doomed) await target.deleteSession(id)             // 2.
  await target.saveCourses(withoutCourse(await target.loadCourses(), courseId))  // 3. COMMIT
  return { sessionsDeleted: doomed.length }
}
```

**[R2] Step 3 re-reads.** Revision 1 built the commit write from the pre-step-1 snapshot — which is
*exactly* the `importIntoStorage` hole item 6 diagnoses, reproduced in new code. With multiple pending
ids it was worse: each per-id commit reverted the previous one. Every commit write is now built from a
fresh read.

`withoutCourse` drops the course, clears `lastCourseId` when it pointed at it, and removes that entry
from `pendingCourseDeletions` — one write, one commit point.

The doomed set comes from `listSessions()` because `SessionSummary` already carries `courseId`, so no
second scan of session bodies is needed. **[R2] Note the honest caveat:** `listSessions()` *is* a
`readDocument` scan and *does* quarantine corrupt files as a side effect — revision 1 claimed otherwise.
Choosing it is still right (a delete triggers no scan the app would not otherwise do), but the stated
reason was false.

```ts
export async function resumePendingDeletionsFromStorage(t: DeleteTarget): Promise<ResumeOutcome[]> {
  const outcomes: ResumeOutcome[] = []
  for (const pending of (await t.loadCourses()).settings.pendingCourseDeletions ?? []) {
    const live = (await t.listSessions()).filter((s) => s.courseId === pending.courseId)
    const strays = live.filter((s) => !pending.sessionIds.includes(s.id))
    if (strays.length > 0) {
      // [R2] Flown again since the interrupted delete. Destroying these would destroy
      // data the confirmation never counted. Abandon: clear the marker, keep the course.
      await t.saveCourses(withoutPending(await t.loadCourses(), pending.courseId))
      outcomes.push({ kind: 'abandoned', ...names(pending), reason: 'flown-since' })
      continue
    }
    for (const id of pending.sessionIds) await t.deleteSession(id)
    await t.saveCourses(withoutCourse(await t.loadCourses(), pending.courseId))
    outcomes.push({ kind: 'completed', ...names(pending), sessionsDeleted: pending.sessionIds.length })
  }
  return outcomes
}
```

### 4. Implementations + the resurrection guard — **[R2] guard widened**

**`OpfsStorage`**: `deleteSession`, `deleteCourse`, `resumePendingDeletions`. Use `dir.removeEntry(name)`
as `quarantine()` already does — not `FileSystemHandle.remove()`.

Two instance-scoped sets close the resurrection window:

```ts
private readonly deletedSessionIds = new Set<string>()
private readonly deletedCourseIds = new Set<string>()   // [R2]
```

**Why the course set.** The session set only knows ids that existed in the pre-cascade `listSessions()`
snapshot. But `fly-session.svelte.ts:501` does `void persister.flush()` — fire-and-forget, outliving its
component — and `saveSession` opens with `{ create: true }`. A persister write for a session **not yet on
disk** (armed moments earlier, first write still in flight or in `write-failed` retry) lands *after* the
commit and creates a session file whose course is gone: exactly the ghost state this design forbids, and
revision 1's "every interleaving converges on gone" was false. `saveSession` therefore rejects
`not-found` when `deletedSessionIds.has(session.id)` **or** `deletedCourseIds.has(session.courseId)`.

`saveSession` checks **before and after** the write — a check only at the top is passed by a write already
inside `writeTextFile`:

```ts
this.assertNotDeleted(session)               // id OR courseId → StorageError('not-found')
await this.writeTextFile(dir, name, text)
if (this.isDeleted(session)) {
  await dir.removeEntry(name).catch(() => {})  // compensate: the write re-created it
  this.assertNotDeleted(session)
}
```

**[R2] A failed `deleteSession` must un-record the id.** Revision 1 recorded it before the I/O and never
removed it, so a `deleteSession` that threw `write-failed` would permanently poison a session that still
exists — every later `saveSession` for it rejects `not-found`, and the live persister silently stops
saving laps. Record before, un-record in the `catch` for anything that is not `NotFoundError`.

**Nothing awaits pending writes.** `flush()` never resolves against a hung storage
(`session-persister.ts:30-31`), so awaiting quiescence would leave the Delete button spinning forever at a
flying field. `SessionPersister.abandon()` is not needed: a tail write for a deleted id now rejects
`not-found`, and the persister retries only `write-failed`, so the straggler dies quietly.

`importAll` re-admits the ids it is about to write, or importing an export that still contains data deleted
earlier in this tab aborts mid-import:

```ts
importAll(envelope: ExportEnvelope): Promise<ImportResult> {
  for (const c of envelope.courses) this.deletedCourseIds.delete(c.id)
  for (const s of envelope.sessions) this.deletedSessionIds.delete(s.id)
  return importIntoStorage(this, envelope)
}
```

**`MemoryStorage`** mirrors all of it (synchronous writes, so the pre-check alone suffices — but keep the
same fields so the contract suite cannot tell the two apart).

### 5. Export integrity — **[R2] the "only undo" must not be torn**

`backup-nudge.ts`: extract `hasUnexportedSessions({ sessionSummaries, lastExportAt })` with **no recency
clause** and re-express `shouldNudgeBackup` on top of it. Today's predicate ANDs in a 7-day gate
(`backup-nudge.ts:27`), so reusing it in the confirm screen would show **no warning** to a pilot who
exported Monday, flew ten sessions Saturday and deletes on Sunday — exactly the person the warning exists
for. The confirm screen evaluates it over the **doomed** sessions only.

**[R2] `loadAllSessions('strict')` silently skips a file that vanishes mid-scan.** It collects names first,
then reads each; a `getFileHandle` on a since-removed name throws `NotFoundError`, which `readDocument`
maps to `{status:'not-found'}` — and strict mode only rethrows on *thrown* errors, so the session is
dropped from the export with no error. `storage.md` promises the opposite ("a session file that cannot be
read fails the whole export rather than silently omitting data"). In strict mode, a name that was listed and
is then not-found must **reject**. Without this, "Export backup first" can hand the user a truncated backup
and then record `lastExportAt` for it.

`buildExportFilename` gains **seconds**: it is minute-granular, and this feature actively encourages export
→ delete → export inside one minute. Same filename twice, and an overwriting share target turns the undo
file into a post-delete snapshot.

### 6. Repo layer — **[R2] one critical section, no exceptions**

`CoursesRepo.enqueueWrite` is the app's *only* serialization point for `courses.json`, which is a
whole-document read-merge-write. **Every** operation that reads-then-writes it, or that must not observe it
half-done, goes through the queue:

| Operation | Why it must be queued |
|---|---|
| `deleteCourse` | Racing `updateSettings` persists a stale `coursesList` and **resurrects the course** |
| `resumePendingDeletions` | **[R2]** Same hazard — see below |
| `importAll` | `importIntoStorage` snapshots the course list before writing; a delete committing inside that prelude is reverted |
| `exportAll` | **[R2]** A cascade removing files mid-scan tears the export |

Each queued op that writes `courses.json` behind the repo's cached snapshot **must `reload()` inside the
queued op, on both outcomes** — including `importAll`, which revision 1 queued but never reloaded. Without
it, the next fire-and-forget `updateSettings` persists the stale `coursesList` and undoes the whole
operation. (`reload()` is deliberately outside the queue — `repos.ts:117` — so calling it from inside a
queued op cannot deadlock.)

**[R2] The resume must not be a peer writer.** Revision 1 had `StorageContext` call
`storage.resumePendingDeletions()` directly on construction — its own `loadCourses`→`saveCourses` cycle,
outside the queue, against a snapshot the repo does not share. Five reviewers independently found this. Three
ways it loses data, one of which needs no race at all: resume commits cleanly, `coursesRepo.coursesList` still
holds the deleted course, the user arms a flight (`FlyFlow.svelte:49` → `updateSettings({lastCourseId})`) →
`repos.ts:173` persists the stale list → **the course is resurrected, empty, its sessions destroyed**. So:

```ts
// CoursesRepo
resumePendingDeletions(): Promise<ResumeOutcome[]> {
  return this.enqueueWrite(async () => {
    const outcomes = await this.storage.resumePendingDeletions()   // never rejects
    if (outcomes.length > 0) await this.reload()
    return outcomes
  })
}
```

`storage-context.svelte.ts` composes the cross-repo invalidation, as it already must for `deleteCourse` (the
cascade removes session files behind `SessionsRepo`'s back — `storage-context.ts:43-47`):

```ts
const outcomes = await coursesRepo.resumePendingDeletions()
if (outcomes.length > 0) await sessionsRepo.refresh()
```

`SessionsRepo.deleteSession` splices `summariesList` in place and — unlike `loadSession`/`latestForCourse` —
**does** set `lastError`: a failed delete is an app-wide storage condition, not a per-caller miss.

~~**Home's `statsByCourse` cache** (`Home.svelte:30-38`) is computed once per mount; a resume that lands
after it must trigger a recompute, or the resumed course's records stay on screen.~~ **Struck during
implementation — the mechanism is not needed and was deliberately not built.** Home renders its cards from
`repo.courses`, which the queued `reload()` updates: a completed resume takes the card away with the course
(a stats entry keyed by a course id nothing renders is unreachable, not stale), and an abandoned resume
changes nothing. No observable failure exists to fix.

### 7. Routes

`#/course/<id>/delete` and `#/session/<id>/delete` in `route.ts` (`routeFromHash` + `hashFor`, which
round-trip by test). `#/course/new/delete` must not parse, exactly as `new` is already reserved against
`edit`.

### 8. Confirmation screens — **[R2] never render counts from an unloaded repo**

`DeleteCourse.svelte` and `DeleteSession.svelte` — ordinary screens with an `AppBar`, built from existing
tokens. Contents: blast radius, the backup warning when it applies, **Cancel** above **Delete**, and a
`.notice-error` that holds the screen on failure (retry is safe — both methods are idempotent).
`disabled={context.readOnly}`.

**The load gate is load-bearing.** Revision 1 said counts "come from `sessionsRepo.sessionsForCourse(courseId)`
… with zero session-body loads", falling back to count-free copy only when `lastError !== null`. But an
*unloaded* repo has an empty `summariesList` and a null `lastError` — so the screen would render **"Nothing has
been flown on this course yet"**, suppress the not-backed-up warning, and then destroy twelve sessions. The
screen must `await sessionsRepo.refresh()` and keep the Delete button **disabled until the counts have loaded**.
Never state a count, and never suppress the backup warning, on the strength of a repo that has not answered.

`DeleteSession` loads the session body (one file) — `SessionSummary` carries `lapCount` but not the best lap,
so revision 1's "zero session-body loads" was false for that screen.

On success, `location.replace()` to the parent (home after a course delete; the course, or home for an orphan,
after a session delete). **[R2] Honest limit:** `replace()` only consumes the *confirm* route's entry — Back
still reaches `#/course/<id>`, whose existing not-found branch is the safety net. Soften that copy to "This
course does not exist — it may have been deleted." Say nothing on success: the thing being gone from the screen
you land on is the confirmation, and there is no cross-route notice channel.

**[R2] The flash guard belongs here, not on `CourseForm`.** Revision 1 put a `deleting` flag on `CourseForm` to
stop its `$derived` `notFound` branch flashing — but `CourseForm` is *unmounted* during the delete (the confirm
screen is a different route). The screen that can flash "This course does not exist" mid-delete is
`DeleteCourse.svelte` itself, which reads the same derived state. Guard there.

### 9. Copy — `src/ui/screens/delete-copy.ts` (+ unit tests)

Pure functions, per the `course-format.ts` / `fly-format.ts` / `export-action.ts` idiom. Lift `plural()` out of
`Home.svelte:40` into `course-format.ts` and share it.

- Course: **Delete "Basement 3-gate"?** — *This also deletes 12 sessions and 340 laps flown on this course. It
  cannot be undone.* (one: *1 session and 28 laps*; zero: *Nothing has been flown on this course yet.*)
- Lap count is **all** laps, valid + discarded — do not undersell the blast radius.
- Session: **Delete this session?** — *Sunday 12 Jul, 14:30 — 28 laps, best 14.32 s. It cannot be undone.*
- Buttons: **Delete course and 12 sessions** / **Delete session**; **Cancel**.
- Backup warning (`.notice-warning`): never exported → *Not backed up — you have never exported. An export file
  is the only way to get this back.* Newer than last export → *…some of this was flown after your last export…*
  With an **Export backup first** button wired to `runExport(context)`. It **never auto-continues into the
  delete**. It must not over-claim: `export-action.ts:6-9` says the anchor path cannot observe a cancelled save
  dialog, so delivery means "we handed it over" — *Exported chronowhoop-export-….json. Check it saved — importing
  that file restores this course.*
- Failure: *Deleted 7 of 12 sessions — the course is still here. Try again.*
- **[R2] Resume notices** (item 10): *Finished deleting **Basement 3-gate** — an earlier deletion was
  interrupted.* / *An interrupted deletion of **Basement 3-gate** was abandoned — you have flown on it since.*

### 10. Resume on startup

`StorageContext` calls `coursesRepo.resumePendingDeletions()` (item 6 — **not** the storage directly) once on
construction and surfaces each outcome as a dismissible notice. **[R2] The notice lives in `App.svelte`**,
alongside the existing quarantine notices — not on Home, which a relaunch may not land on (the app restores the
last hash route).

Auto-resume completes an instruction the user already confirmed, bounded to the sessions they saw counted; the
`abandoned` outcome is what stops it completing an instruction they walked away from. The notice is what keeps
either from being silent.

### 11. Icons and the danger variant

`.btn-danger-ghost` in `App.svelte`'s global button block, reusing `.notice-error`'s existing
`rgba(255, 82, 101, …)` pair. It dresses the *initiating* controls (edit form, session view). Filled
`.btn-danger` stays reserved for the confirm button on the delete screens: today it dresses exactly one control —
the armed STOP button (`FlyArmedPanel.svelte:129`) — which pilots slam from muscle memory. Do not dilute it.

`FlyArmedPanel.svelte:126` — "Discard last lap" **gives up the trash glyph** (a strike-through mark instead).
Discard keeps every byte; the trash can now means destruction. Behaviour unchanged.

`CourseForm.svelte:8`'s comment ("Deletion is out of scope per the product spec.") dies here.

### 12. Docs (same commit)

- **`product.md`** — replace line 9; add a **Deleting** section: what deletes what, confirmation, permanence,
  discard-vs-delete, records need no maintenance (they are derived), deleting a course's most recent session
  rolls the config/note prefill back to the one before it (correct — the prefill means "what you last used
  here"), the export is the recovery path, and importing an old file brings deleted data back **by design**. Add
  the three non-goals.
- **`storage.md`** — a **Deletion** section: the methods; the two-phase order and *why*; the bounded work list and
  the `flown-since` abandonment rule; the accepted partial states; idempotence; `lastCourseId` cleared in the same
  write; **[R2]** an unreadable session file cannot be attributed to a course, so it **survives a cascade** and — if
  `unsupported-version` — keeps failing a strict export even after its course is gone; quarantine copies are never
  removed; the in-memory resurrection guard; **no tombstones — re-importing an older export re-adds deleted items**.
  Sharpen the orphan bullet: orphans arise from import, an interrupted delete, and an unreadable file outliving its
  course.
- **ADR 0011 — deletion cascade, ordering, and the intent marker.** Cascade (orphans stay import-only);
  hard/immediate/permanent with the export as the recovery path; the two-phase marker as a consequence of ADR 0010's
  per-file-only atomicity; the marker as a *bounded work list* and why re-deriving it is unsafe; **no persisted
  tombstones** — naming the in-memory, instance-scoped resurrection guard as the deliberate exception, in those words,
  so a future reader does not "fix the inconsistency" by persisting it and destroy the only undo the product has.
  **[R2]** It **amends ADR 0010's decision 3 and its 2026-07-13 amendment**: that amendment retired the startup sweep
  because "our writes create no artifacts of their own", which this phase makes untrue. State plainly that the resume
  is not the sweep 0010 rejected (which would have guessed intent from stray filenames); it replays an intent we
  recorded on purpose, in a file we own. Cite 0010; never edit it.
- **`docs/mockups/ui-mockups.html`** — the design source of truth, which has no delete affordance anywhere: add screen
  **02b Edit course** (danger block below the Save CTA), **10 Delete course**, **11 Delete session**, plus the
  `.btn-danger-ghost` rule beside `.btn-danger`. Leaving the mockups silent is exactly how this class of gap went
  unnoticed for seven phases.

## Verification

- **Storage contract** (`storage-contract.ts`) — the primary vehicle: it runs against MemoryStorage in node *and* real
  Chromium OPFS from one source. New `describe('deletion')`: cascade removes exactly the course's sessions and no
  others; idempotent double-delete resolves; unknown id resolves; `lastCourseId` cleared only when it pointed at the
  deleted course; a deleted session's `saveSession` rejects `not-found`; a `saveSession` for **any** session of a
  deleted **course** rejects `not-found`; a *failed* `deleteSession` leaves the session saveable; `importAll` re-admits
  both; **re-importing a pre-delete export restores everything** (the intended-resurrection pin).
- **Marker semantics [R2]**: a resume deletes only the recorded `sessionIds`; a session flown on the course after an
  interrupted delete triggers `abandoned` and the course survives intact; a marker for multiple courses resumes all of
  them without any commit reverting another.
- **Crash simulation** (OPFS, extending the Wave B tests): kill between steps 1 and 3; assert the marker survives and
  is *readable back* (the `parseSettings` bug); then resume finishes and clears it.
- **Forbidden state [R2]**: no *readable* session file may outlive its course. State it that way — an unreadable file
  can, by construction, and the plan says so.
- **Repo serialization [R2]** (`repos.test.ts`, mirroring the existing "saveCourse racing updateSettings: both land"):
  a resume racing `createCourse` — both survive; a resume racing `deleteCourse(other)` — neither is reverted; after a
  resume commits, an `updateSettings` write must **not** reintroduce the resumed course; after `importAll`, the same.
- **Compile breaks are the feature.** `repos.test.ts:7` (`failingStorage`) is an exhaustive hand-written `Storage`
  literal and will fail to build the moment the interface grows. (**[R2]** `session-persister.test.ts:345` is *not*
  exhaustive — revision 1 claimed it was; only `:405` is.)
- **Browser tests**: delete a course from the edit form → land on home, course and its sessions gone; delete a session →
  land on the course, records recomputed; read-only tab cannot delete; the confirm screen shows the correct counts on a
  cold mount (the unloaded-repo bug) and the backup warning fires for the exported-Monday-flew-Saturday case.
- **Export integrity [R2]**: a strict export rejects when a listed session file vanishes mid-scan.
- `lint-seams.test.ts` — **no change**, verified: `removeEntry` is already in `eslint.config.js`'s `opfsMethods` and
  enumerated at `lint-seams.test.ts:57-63`. The seam bans OPFS *syntax* outside `src/core/storage/**`. Do **not** add
  `remove` to the ban list — it would fire on `element.remove()` across the UI.

## Risks retired

- **Ghost data** — cascade plus the widened resurrection guard mean no *readable* session file can outlive its course.
  (An unreadable one still can; that is documented, not fixed — its `courseId` lives in bytes we could not parse.)
- **A half-deleted course that lies about itself** — the intent marker makes the partial state self-describing and
  self-healing.
- **A deletion the user abandoned, completed behind their back** — the bounded work list plus the `flown-since`
  abandonment rule.
- **Resurrection by a straggling write** — the `deletedSessionIds` + `deletedCourseIds` guard.
- **Resurrection by import, export, or resume** — all four `courses.json` operations share one critical section.
- **A user deleting their only copy while believing they have a backup** — the confirm screen tells the truth about
  `lastExportAt` (no 7-day blind spot), refuses to guess counts from an unloaded repo, offers an export first, and that
  export can no longer be silently truncated.
