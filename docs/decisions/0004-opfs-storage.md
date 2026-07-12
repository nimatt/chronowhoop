# 0004 — OPFS storage behind an interface; export/import for cross-device

**Status:** accepted, 2026-07-12

## Context

The original idea — user picks a local folder via the File System Access API — is desktop-Chromium-only and unavailable on the phone-first platforms ([0001](0001-phone-first-pwa.md)). With no backend, cross-device data flow still needs an answer.

## Decision

All platforms persist JSON to OPFS through a single `Storage` interface. Layout: `courses.json` plus one file per session, each carrying `schemaVersion`. Cross-device flow is explicit export (download/share sheet) and merge-by-ID import. Records are computed from lap data, never stored.

The interface is a deliberate seam: desktop local-folder mirroring and backend sync are future implementations, not v1 features.

## Consequences

- Same storage code on every platform; one failure mode.
- OPFS is origin-scoped — clearing site data deletes everything. Request `navigator.storage.persist()`, prompt for exports as backup.
- Per-session files keep live-session writes small; a crash loses at most the last lap write.
