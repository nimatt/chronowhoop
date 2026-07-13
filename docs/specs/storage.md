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
    "lastCourseId": "…"                        // optional; most recently used course
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

- **Export**: one self-contained JSON document — the export envelope `{ schemaVersion, exportedAt, courses, settings, sessions }` — delivered via download or the share sheet (phones). The envelope carries the same global `schemaVersion` as the files and is validated/migrated on import like any other read.
- **Exports must be trustworthy:** a session file that cannot be read (infrastructure failure or unsupported version) fails the whole export rather than silently omitting data; the only omissions are files quarantined as corrupt, which the quarantining read already surfaced. Session *listings* make the opposite trade — availability over completeness — and skip unreadable files.
- **Import** parses and validates/migrates the file like any other read, and can only ever fail with a `StorageError`: an envelope whose `schemaVersion` is newer than the app's (or unreachable by migration) is refused up front as `unsupported-version` with an "update the app" message — never partially applied; malformed or invalid files map to `corrupt`, carrying the offending field's `$`-rooted path.
- **Import merges by ID** — unknown IDs are added, existing IDs are skipped (no overwrite in v1; add/skip counts are reported to the user). Course name collisions with different IDs import as separate courses. Courses are applied first (one `courses.json` write with the merged course list), then sessions one file at a time — a session can never land before a course it references, and a course with zero sessions is a valid state. A mid-import write failure aborts with that write's error; recovery is re-importing the same file, which merge-by-ID makes idempotent (already-landed items are skipped). One accepted edge: existing session IDs come from the session listing, which skips unreadable files — a session file refused locally as `unsupported-version` is invisible to the merge, so an import carrying the same ID overwrites it (reachable only via a version rollback followed by an import of that same session).
- **Orphan sessions** — a `courseId` matching no course even after the merge — are retained, never dropped: they export and render with an "unknown course" placeholder when opened; v1 does not list them under any course.
- **Local settings always win on import**: the envelope's `settings` object is ignored entirely — though the import's course write-back re-persists the settings it read at its start, so a settings write racing the import in the same tab (e.g. `lastExportAt`) can be reverted (accepted; costs at most one extra backup nudge).
- Export/import is the v1 answer to cross-device flow: record on the phone, export, import on desktop for review.

## Durability notes

OPFS is origin-scoped browser storage: clearing site data deletes everything. The app requests `navigator.storage.persist()` once, after the first successful write (asking before any data exists would waste the prompt), and surfaces whether it was granted. Regular exports are the user's backup: after a stopped session the UI gently nudges toward an export when at least one session started after `settings.lastExportAt` (any session at all when nothing was ever exported) AND the last export is absent or more than 7 days old (`shouldNudgeBackup`, injected clock).

A file that fails parsing or validation is quarantined aside as `<name>.corrupt.<ts>` with a warning, and the app continues — one bad session file loses one session, never the app (ADR 0010).
