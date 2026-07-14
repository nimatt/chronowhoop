# Storage spec

All persistence goes through a single `Storage` interface. The only v1 implementation is OPFS (origin-private file system), available on every target platform. The interface is the seam for future implementations: desktop local-folder mirroring (File System Access API) and backend sync.

## File layout (OPFS root)

```
courses.json          # all courses + app-level settings
sessions/
  <sessionId>.json    # one file per session, laps included
```

- **Why per-session files:** during a live session only that session's file is rewritten after each lap — writes stay small, and a crash loses at most the most recent lap.
- A session's file is created when the session is armed, before the first crossing — a zero-lap crash leaves a recoverable session record.
- Writes go through `createWritable()`, whose swap-file commit-on-close replaces file content atomically; an interrupted write (abort, crash, tab kill) leaves the previous content intact ([ADR 0010](../decisions/0010-atomic-writes-opfs.md)).
- **No session index file in v1:** session lists and course views scan `sessions/` and derive summaries on read.
- **Multi-tab:** a Web Locks single-writer lock guards all writes; additional tabs run read-only with a read-only notice explaining another tab is active (ADR 0010). A denied lock request is re-requested once after a short delay before the tab settles into read-only, so a refresh race with a dying predecessor tab cannot permanently strand a lone tab.
- IDs are `crypto.randomUUID()`.

## Schema

**One global `schemaVersion` (integer; currently 1)** is shared by `courses.json`, session files, and the export envelope. Readers migrate old versions forward on load (a registry of vN→vN+1 transforms); writers always write current, and validate the document before writing it — an invalid save fails immediately (`write-failed`) instead of poisoning a future read. Every read path runs a structural validator before the content is trusted — required fields and types are strict, unknown extra keys are tolerated (forward-compat reads), and a document that fails validation is quarantined (ADR 0010), never half-used. A document whose `schemaVersion` is **newer** than the app's is not corrupt and is not quarantined: it is refused in place (error kind `unsupported-version`, file untouched) — updating the app makes it readable again; a document reachable by no registered migration chain is refused the same way. The `Storage` interface itself trades in domain shapes; envelopes, validators, and migrations live in the file layer (`src/core/storage/schema.ts`).

```jsonc
// courses.json — all courses plus the app-level settings object
{
  "schemaVersion": 1,
  "courses": [
    {
      "id": "…",
      "name": "Basement 3-gate",
      "direction": "ltr",          // which strip-traversal direction counts
      "minLapTimeMs": 3000,
      "createdAt": "2026-07-12T09:30:00Z"
    }
  ],
  "settings": {
    "speechEnabled": true,                     // default true
    "lastExportAt": "2026-07-12T18:00:00Z",    // optional; absent until the first export
    "lastCourseId": "…",                       // optional; most recently used course
    // Optional; absent unless a course deletion is in flight (see Deletion).
    // An added optional key needs no schemaVersion bump: forward-compatible on
    // read, and an older app drops it on its next write.
    "pendingCourseDeletions": [
      { "courseId": "…", "courseName": "Basement 3-gate", "sessionIds": ["…", "…"] }
    ]
  }
}
```

```jsonc
// sessions/<id>.json
{
  "schemaVersion": 1,
  "id": "…",
  "courseId": "…",
  "startedAt": "2026-07-12T10:05:00Z",
  "note": "new props, 300mah",
  // Full detection snapshot: pipeline tunables + crossing-detector config,
  // composed at the session layer. Frozen and validated by the Phase 6 schema
  // contract (SessionDetectionConfig).
  "detectionConfig": {
    "tunables": {
      "roi": { "x": 0.1, "y": 0.2, "width": 0.8, "height": 0.5 },
      "stripCount": 12, "triggerLevel": 0.4, "emaTimeConstantMs": 325, "threshold": 25
    },
    "detector": {
      "triggerLevel": 0.4, "hysteresisRatio": 0.5, "entryZoneStrips": 2,
      "maxBackstepStrips": 1, "minTraversalMs": 0, "maxTraversalMs": 1500,
      "minParticipatingStrips": 3, "transientStripFraction": 0.7,
      "transientHoldoffMs": 300, "maxPauseMs": 2000
    }
  },
  "laps": [
    { "n": 1, "durationMs": 14320, "completedAt": "2026-07-12T10:06:02.310Z", "status": "valid" },
    { "n": 2, "durationMs": 13980, "completedAt": "2026-07-12T10:06:16.290Z", "status": "discarded" }
  ]
}
```

Records (best lap, best three consecutive) are **never stored** — always derived.

## Export / import

- **Export**: one self-contained JSON document — the export envelope `{ schemaVersion, exportedAt, courses, settings, sessions }` — delivered via download or the share sheet (phones). The envelope carries the same global `schemaVersion` as the files and is validated/migrated on import like any other read. Its `settings` are the local settings **minus any in-flight deletion marker** (`pendingCourseDeletions`, see Deletion): a marker is state of *this store* — "a destruction of this course is in flight here" — not user data. An export file is a human-inspectable snapshot of the data, and it must neither advertise a destruction in flight nor carry that instruction into whatever store it is imported into.
- **Exports must be trustworthy:** a session file that cannot be read (infrastructure failure or unsupported version) fails the whole export rather than silently omitting data — and so does a file that was listed and then *vanishes before it is read* (a cascade removing it, another tab), which used to be dropped in silence because a not-found read is reported as a status rather than an error. The only omissions are files quarantined as corrupt, which the quarantining read already surfaced. Session *listings* make the opposite trade — availability over completeness — and skip unreadable files.
- **Import** parses and validates/migrates the file like any other read, and can only ever fail with a `StorageError`: an envelope whose `schemaVersion` is newer than the app's (or unreachable by migration) is refused up front as `unsupported-version` with an "update the app" message — never partially applied; malformed or invalid files map to `corrupt`, carrying the offending field's `$`-rooted path.
- **Import merges by ID** — unknown IDs are added, existing IDs are skipped (no overwrite in v1; add/skip counts are reported to the user). Course name collisions with different IDs import as separate courses. Courses are applied first (one `courses.json` write with the merged course list), then sessions one file at a time — a session can never land before a course it references, and a course with zero sessions is a valid state. That same courses write **abandons every pending deletion marker the file touches** (see Deletion — No tombstones), ahead of any session write, so an import that dies half-way still cannot leave a marker that would replay a cascade over what it just restored. A mid-import write failure aborts with that write's error; recovery is re-importing the same file, which merge-by-ID makes idempotent (already-landed items are skipped). One accepted edge: existing session IDs come from the session listing, which skips unreadable files — a session file refused locally as `unsupported-version` is invisible to the merge, so an import carrying the same ID overwrites it (reachable only via a version rollback followed by an import of that same session).
- **Orphan sessions** — a `courseId` matching no course — are retained, never dropped: they export and render with an "unknown course" placeholder when opened; v1 does not list them under any course. They arise from **import** (a session whose course is in neither the file nor the store) and from an **unreadable session file outliving its course** (see Deletion — it cannot be attributed to a course, so a cascade cannot condemn it). A *completed* course deletion never manufactures one; an *interrupted* one leaves the opposite state (a course still standing, short of sessions it lists), which the intent marker exists to finish or abandon.
- **Local settings always win on import**: the envelope's `settings` object is ignored entirely — though the import's course write-back re-persists the settings it read at its start, so a settings write racing the import in the same tab (e.g. `lastExportAt`) can be reverted (accepted; costs at most one extra backup nudge).
- Export/import is the v1 answer to cross-device flow: record on the phone, export, import on desktop for review.

## Deletion

Two seam methods, plus a resume. Deletion adds no `StorageErrorKind` — it is a write, and fails like one (`write-failed` / `quota-exceeded`; a two-phase delete writes `courses.json` twice, so it can hit quota even while freeing space). A read-only tab rejects `write-failed` through the same writer-lock guard every other write uses, and *that* is the real guard: `readOnly` is still false for the short window in which the lock request settles, so a delete button disabled on that flag is cosmetic. Both implementations share one cascade (`src/core/storage/delete.ts`), the way both share the import merge, so the ordering invariant below is literally the same code in both and cannot drift.

- **`deleteSession(id)`** removes the session's file. **Idempotent**: an unknown id *resolves* — the exact opposite of `loadSession`, deliberately, because a double-tap and the retry after a partially-applied cascade must both be safe. It is byte-level, by filename: the document is never read, so a corrupt or unsupported-version session is removed as long as its id is known — deletion is the one operation a broken file cannot refuse. Quarantine copies (`<id>.json.corrupt.<ts>`) are never touched: quarantining was a deliberate rescue, and this is not the quarantine manager.
- **`deleteCourse(id)`** deletes the course **and every session whose `courseId` matches** ([ADR 0011](../decisions/0011-deletion-cascade-and-ordering.md) — cascade, not orphaning), clearing `settings.lastCourseId` when it pointed at that course. Idempotent as well: an unknown course id still sweeps sessions referencing it, which is precisely the retry path after a cascade that died mid-flight.
- **`resumePendingDeletions()`** finishes — or abandons — a cascade a crash interrupted. It **never rejects**: it runs at startup, where there is nobody to retry it, so a failed resume leaves the marker in place for the next launch instead of raising an error no one can act on. It resolves `[]` when nothing is pending, and on a read-only instance, which holds no writer lock and must not try.

### Two-phase, because atomicity is per-file

ADR 0010 gives per-file atomicity and **no multi-file transaction**. A cascade touches many files, so it cannot be made atomic — the only thing left to choose is *which* crash state it can leave behind:

0. `loadCourses()` and `listSessions()` — **read before destroy**. Nothing is touched until both succeed: `loadCourses` can reject `unsupported-version`, and discovering that *after* the session files were gone would strand condemned data in a state no retry can finish (sessions destroyed, course still standing, nothing on disk saying why).
1. Write `courses.json` with the course **still present** and the intent marker added — the exact session ids, captured now. **[INTENT]**
2. Remove those session files.
3. Re-read `courses.json` and write it back without the course and without the marker. **[COMMIT]** — the single point at which the deletion becomes true. Step 3 re-reads rather than reusing the step-1 snapshot, so a concurrent write (or another marker's commit) is not reverted by this one.

A crash between 1 and 3 therefore leaves a course that is visibly still there and is missing sessions it still lists. The marker is what makes that state self-describing and self-healing.

### The marker is a bounded work list

`settings.pendingCourseDeletions` holds `{ courseId, courseName, sessionIds }` per in-flight deletion. `sessionIds` is **exactly the sessions the user saw counted and confirmed**, and a resume deletes those ids and nothing else. Re-deriving the doomed set at resume time (filtering live sessions by `courseId`) would turn an abandoned deletion into an *unbounded standing instruction*: fail a delete, walk away, fly the course for another month, and the next launch destroys sessions that did not exist when the confirmation was given. `courseName` is captured in step 1, while the course entry still exists, so a resume can name the course in its notice without depending on the course surviving. The key is absent — never `[]` — when nothing is pending; a leftover empty array would be a file that says "a deletion is in flight" for the rest of time.

**Abandonment (`flown-since`).** Before replaying a marker, the resume compares the course's live sessions against the recorded ids. If any live session is *not* on the list, the course was flown again after the interrupted deletion: the marker is cleared, the course and all its sessions survive, and the user is told. Deleting again re-states the real, current blast radius.

`lastCourseId` is cleared in the **commit** write only, never in INTENT — a crash between the two then leaves it pointing at a course that still exists (harmless), rather than making a user-visible change with no deletion to show for it. The commit drops the course, its marker, and `lastCourseId` in one write, precisely so there is no crash window between "course gone" and "marker gone".

`pendingCourseDeletions` is an added optional `AppSettings` key with **no `SCHEMA_VERSION` bump**: it is forward-compatible on read, and an older app drops it on its next write — degrading to the un-marked partial state, which fails safe (a course short of sessions, not a course destroyed).

### What survives a cascade

An **unreadable** session file cannot be attributed to a course — its `courseId` lives in bytes we could not parse, so the listing that knows about courses never sees it. It therefore **survives the cascade** and becomes an orphan; if it was refused as `unsupported-version`, it goes on failing every strict export even after its course is gone. Documented, not fixed: there is no honest way to condemn a file we cannot read. (The doomed set comes from the session listing, which *is* a real read scan and *does* quarantine corrupt files as a side effect — so a delete can produce a quarantine notice.)

### The resurrection guard: in-memory, instance-scoped

Each `Storage` instance remembers, **in memory only**, the session ids and the course ids it has deleted. A `saveSession` for a deleted session — or for *any* session of a deleted course — rejects `not-found` for the life of that instance. The course set is not redundant: the live-session persister writes fire-and-forget and outlives its component, and `saveSession` creates the file if it is missing, so a tail write for a session that was not yet on disk when the cascade scanned (armed moments earlier, first write still in flight) would otherwise land *after* the commit and create a session file whose course is gone. `not-found` is the deliberate kind — the persister retries `write-failed` and nothing else, so the straggler dies quietly instead of retrying its way back onto disk. On OPFS the check runs before *and* after the write, because a write already inside `createWritable()` when the delete ran re-creates the file the delete removed; the post-write check removes it again, which is what makes every interleaving converge on "gone". That compensating removal is the last line of defence against a readable session file outliving its course, so a removal that fails is retried and then **raised** (`write-failed`), never swallowed: the file it could not remove would otherwise sit on disk invisibly (no screen lists a session whose course is gone), unattributable once the instance dies with the page, and ride out in every later export as an unknown course.

A course is condemned **before the read-before-destroy scan**, not after it: the scan takes real time, a session armed while it runs is in no snapshot the cascade will ever take, and the session set can therefore never learn that id — the course set is the only thing that can catch it. The **resume condemns the same way and just as early**, because it ends in the same commit and it runs unawaited at startup while the course is still listed (the INTENT write keeps it present on purpose), so a pilot can tap that course and arm a flight inside the window. Both entry points drive the guard through the shared cascade rather than each bolting on its own, so they cannot drift.

Every id is **released when the deletion does not happen**. A `deleteSession` that fails, a cascade that fails, and a resume that abandons on `flown-since` all leave data standing: the course is flyable and the session is still there. Leaving either condemned would poison it for the life of the tab — every later `saveSession` rejecting `not-found` while the persister, which retries `write-failed` and nothing else, silently stops saving the laps a pilot is flying right now. Sessions a failing cascade *did* remove stay guarded: `deleteSession` records each one individually, and only un-records its own on its own failure.

`importAll` re-admits every id in the envelope before writing, or importing an export that still contains something deleted earlier in the same tab would abort mid-import on the guard.

### No tombstones

Nothing on disk records that anything was deleted, so **re-importing an older export re-adds the deleted items**. That is the restore path, not a bug (ADR 0011): the export file is the only undo this product has, and tombstones would make the import silently drop sessions the user just handed it — on the exact phone→desktop path this spec calls the v1 cross-device story. The in-memory guard above is the one deliberate exception, and it must stay in memory.

The restore is why an **import abandons every marker it touches** — any marker naming a course the envelope carries, or naming a session it carries. A marker that survived a restore would be replayed by the next launch, and the `flown-since` rule could not save it: the marker's recorded ids are *exactly* what the file put back, so not one stray exists and the resume would finish the cascade over the data the user had just restored — destroying it a second time, silently. Abandoning is the safe direction of the trade: it costs a re-confirmation of a deletion the user can still perform (against a blast radius restated from live data); completing it costs the data they explicitly went and got back.

### One critical section

`courses.json` is a whole-document read-merge-write, so every operation that reads-then-writes it — course saves, settings writes, `deleteCourse`, `resumePendingDeletions`, `importAll` — and `exportAll`, which must not observe it half-done, is serialized through a single queue in the UI's courses repository. Two unsynchronized read-merge-write cycles do not merely race: the loser's whole document is overwritten from a stale snapshot, which is how a deleted course comes back from the dead with its sessions genuinely destroyed.

Each queued operation that writes the document behind the repository's cached snapshot re-reads it inside the queue, on **both** outcomes — and a re-read that *fails* leaves the repository **unloaded**, so every later write bails instead of persisting a snapshot that may predate a commit. Failing closed is the only safe direction: the snapshot a failed reload leaves behind is precisely the one that still holds the deleted course, and the next fire-and-forget settings write would put it back on disk with its sessions already gone.

## Durability notes

OPFS is origin-scoped browser storage: clearing site data deletes everything. The app requests `navigator.storage.persist()` once, after the first successful write (asking before any data exists would waste the prompt), and surfaces whether it was granted.

Regular exports are the user's backup, and "is this backed up?" has exactly one definition: `hasUnexportedSessions` — at least one session started after `settings.lastExportAt` (any session at all when nothing was ever exported), with **no recency clause**. The post-session nudge is that predicate AND a staleness gate (`shouldNudgeBackup`, injected clock: no export ever, or the last one more than 7 days old). The delete confirmation uses the bare predicate, over the *doomed* sessions only: the nudge's 7-day gate would stay silent for the pilot who exported on Monday, flew ten sessions on Saturday and deletes on Sunday — exactly the person that warning exists for. Export filenames carry seconds (`chronowhoop-export-<YYYYMMDD>-<HHMMSS>.json`), because export → delete → export inside one minute is a flow this feature actively encourages, and an overwriting share target would otherwise turn the undo file into a post-delete snapshot.

A file that fails parsing or validation is quarantined aside as `<name>.corrupt.<ts>` with a warning, and the app continues — one bad session file loses one session, never the app (ADR 0010).
