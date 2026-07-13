# Storage spec

All persistence goes through a single `Storage` interface. The only v1 implementation is OPFS (origin-private file system), available on every target platform. The interface is the seam for future implementations: desktop local-folder mirroring (File System Access API) and backend sync.

## File layout (OPFS root)

```
courses.json          # all courses + app-level settings
sessions/
  <sessionId>.json    # one file per session, laps included
```

- **Why per-session files:** during a live session only that session's file is rewritten after each lap — writes stay small, and a crash loses at most the most recent lap.
- Writes are write-temp-then-rename where OPFS allows, to avoid torn files.
- IDs are `crypto.randomUUID()`.

## Schema

Every file carries `schemaVersion` (integer). Readers migrate old versions forward on load; writers always write current.

```jsonc
// courses.json
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
  ]
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
  // composed at the session layer. Phase 6's schema freeze validates this
  // exact shape.
  "detectionConfig": {
    "tunables": { "roi": {…}, "stripCount": 12, "triggerLevel": 0.4, "emaTimeConstantMs": 325, "threshold": 25 },
    "detector": { "triggerLevel": 0.4, "hysteresisRatio": 0.5, "maxTraversalMs": 1500, … }
  },
  "laps": [
    { "n": 1, "durationMs": 14320, "completedAt": "2026-07-12T10:06:02.310Z", "status": "valid" },
    { "n": 2, "durationMs": 13980, "completedAt": "2026-07-12T10:06:16.290Z", "status": "discarded" }
  ]
}
```

Records (best lap, best three consecutive) are **never stored** — always derived.

## Export / import

- **Export**: one self-contained JSON document (`{ schemaVersion, courses, sessions }`) delivered via download or the share sheet (phones).
- **Import**: merge by ID — unknown IDs are added, existing IDs are skipped (no overwrite in v1; report counts to the user). Course name collisions with different IDs import as separate courses.
- Export/import is the v1 answer to cross-device flow: record on the phone, export, import on desktop for review.

## Durability notes

OPFS is origin-scoped browser storage: clearing site data deletes everything. The app requests `navigator.storage.persist()` and surfaces whether it was granted. Regular exports are the user's backup; the UI should gently prompt after sessions if no recent export exists.
