# 0010 — Atomic OPFS writes via createWritable swap-commit; quarantine; single writer

**Status:** accepted, 2026-07-13

## Context

`storage.md` promised "write-temp-then-rename where OPFS allows" to avoid torn files. That is not portably implementable: `FileSystemFileHandle.move()` is Chromium-only, and `FileSystemSyncAccessHandle` (the other route to controlled commits) is worker-only. Meanwhile a torn or corrupt file must never brick the app — one bad session file may cost at most that session.

Evidence status: Chromium documents `createWritable()` as writing into a swap file whose content replaces the target atomically on `close()`; until then the original is untouched, and `abort()`, never closing, or killing the tab all leave it intact. The Phase 2 atomic-write probe (`src/core/storage/atomic-write-probe.ts` + the `/diag` OPFS panel) was built to measure exactly these three scenarios, and the real-browser test (`src/core/storage/opfs.browser.test.ts`) verifies the abort case plus the pending-probe round trip in headless Chromium; Wave B's OpfsStorage crash-simulation tests extend this. **The on-device S22 measurement is still owed** ([ADR 0008](0008-device-matrix.md), OPFS table — the `/diag` probes exist but have not been run on the phone). This ADR is written against Chromium semantics plus the real-browser tests, per the plan's 2026-07-12 amendment; transcribe the S22 numbers into ADR 0008 when the device session runs.

## Decision

1. **Every OPFS write goes through `createWritable()` → write → `close()`.** Commit-on-close is the atomicity mechanism; there is no hand-rolled temp-then-rename. A failed or interrupted write (abort, crash, tab kill) leaves the previous file content intact.
2. **Corrupt-read quarantine.** A file that fails JSON.parse or schema validation is quarantined, not trusted and not fatal: OPFS has no rename, so "rename aside" means copying the raw bytes to `<name>.corrupt.<ts>`, removing the original, warning, and continuing. One bad session file loses one session, never the app.
3. **Startup sweep.** On storage startup, stale swap artifacts (`*.crswap`) and orphaned probe/temp files are detected and removed, so interrupted writes cannot accumulate junk or shadow real files.
4. **Web Locks single-writer.** One tab holds the write lock; additional tabs run read-only and show a "session active in another tab" notice. This closes the spec's multi-tab gap without merge logic.

## Consequences

- Atomicity is per-file and inherited from the platform — simple, but there is no multi-file transaction; the schema keeps each session self-contained in one file so none is needed.
- `abort()` on failure paths is best-effort cleanup, not correctness: never calling `close()` is already safe.
- iOS WebKit's `createWritable` semantics are unverified on a device (ADR [0006](0006-ios-best-effort.md)) — best-effort, never gating.
- If the S22 measurements contradict the Chromium semantics (they should not — it is stock Chrome), this ADR is superseded rather than edited.

**Amendment (2026-07-13, Wave B):** implementation found nothing for the startup sweep (decision 3) to do — our writes create no artifacts of their own (`.crswap` staging files are browser-managed, and removing one could race another tab's in-flight write), quarantine files are kept deliberately, and reads skip every non-`.json` name — so OpfsStorage ships without a sweep.
