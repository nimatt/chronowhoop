# Phase 7 — PWA offline, import, hardening: v1 ships

> **ADR 0009 amendment (2026-07-12):** "GPU self-test" reads the `/lab` pipeline self-test (CPU); "GPU golden" CI legs read the node determinism suite; E2E replay uses `ClipSource` (raw luma clips), not `VideoFileSource`/WebCodecs-decode, and lap expectations are exact (no GPU float tolerance). Device-matrix (10) and field acceptance (11) remain manual field items.

## Goal

Install to the home screen, airplane-mode the phone in a basement, run a full session, export via the share sheet, import on desktop and see merged data with add/skip counts on a desktop-worthy layout. Device-matrix and field acceptance pass. This is v1 as specced.

## Scope

**In:** offline hardening, install-flow UI (the partitioning *decision* was made in Phase 2 and acted on in Phase 6 — this phase is polish), share-sheet export delivery, import with merge semantics and fuzz tests, backup nudge, desktop layout pass, permission/capability edge polish, E2E flows, device-matrix checklist, field acceptance protocol, runbooks.

**Out (v1 non-goals, seams only):** multiple pilots, racegow.com integration, CPU fallback, cloud sync, per-crossing video capture.

## Work items (dependency order)

1. **Export delivery polish:** Phase 6's working exportAll gains Web Share API with files on phones (path already proven by the Phase 3 recorder), anchor-download fallback elsewhere; envelope per the Phase 6 schema-contract decision.
2. **Import:** parse → validate → migrate old versions forward → **refuse newer-than-app versions** with a clear "update the app" message (spec gap — decided here); merge by ID (unknown added, existing skipped, counts reported); name-collision courses import separately; **orphan sessions** (courseId matches nothing) imported anyway with an "unknown course" placeholder rather than dropped (spec gap); local settings always win on import (spec gap). **Apply `courses.json` first, then session files:** sessions reference courses via courseId, so courses-first can never leave a dangling reference (a course with zero sessions is a valid state), and a failed import is recoverable via idempotent merge-by-ID re-import. Fuzz/property tests: adversarial and truncated export files never throw uncaught.
3. **Backup nudge:** update `lastExportAt` on export; gentle post-session prompt when no recent export exists — define "recent" (spec gap; recommend: any sessions recorded since last export, or >7 days); persistent indicator when `persist()` was denied. Unit-tested with the injected clock.
4. **Service worker finalization:** verify precache covers everything (WGSL, fonts, icons); Playwright offline test (load once, go offline, full reload works); update-prompt UX polish on the Phase 1 skeleton (build id + one-tap update retained). Manual airplane-mode test of a complete timing session on the Android phone (iOS too if available, non-gating).
5. **Install-flow UI:** `beforeinstallprompt`-driven UI on Android/desktop Chromium; iOS instructions sheet (no prompt API), consistent with Phase 6's install-before-data banner and the Phase 2 partitioning ADR. If any user data predates install on a partitioned iOS device, export/import is the documented migration path.
6. **Desktop layout pass** (moved from Phase 6): min-width media queries over the phone-first CSS, verified against desktop's real use case — import a phone export and review sessions/courses/records.
7. **Capability/permission edge polish:** camera revoked mid-app; `persist()` denied messaging; speech unavailable degradation (visual-only lap display with warning); wake-lock loss surfacing + the orientation app-state binding from `detection.md` (deferred from Phase 6 item 9 — see the 06 notes).
8. **Playwright E2E flows** (MemoryStorage-hermetic where possible, OPFS for the storage legs): create course → session driven by `VideoFileSource` (WebCodecs, deterministic) with an annotated corpus clip → arm → laps appear with expected durations (exact frame-derived expectations thanks to deterministic replay; state ±2 frame intervals only where GPU float paths are in play) → discard last → records update → export file content asserted → import merge on a fresh origin with correct counts.
9. **Real-world tuning pass** from the accumulated fixture corpus: lighting-change re-adaptation, false-trigger review, default sanity check; any field false trigger becomes a clip fixture, tiered per the Phase 3 annotation scheme (the debug recorder stays in production builds; hard cases land as known-limitation without breaking CI, ratcheted in when solved).
10. **Manual device-matrix smoke checklist** committed to `docs/runbooks/`: Android Chrome mid-range phone and desktop Chromium (gating), iOS Safari 26 device (best-effort, run when available, per ADR 0006) — covering exactly what automation cannot: real rear camera at granted fps, **the on-device GPU self-test panel passing** (the only GPU-numeric check on real Metal), TTS timing on short laps, mute-switch behavior, share-sheet export, wake lock, background/foreground recovery while armed, GPU device-loss recovery, 20-minute thermal/battery soak, installed-PWA offline relaunch.
11. **Field acceptance protocol:** N real flight sessions; app laps vs. manual stopwatch and frame-by-frame video review; cross-device run (record on phone → export → import on desktop → records and highlights match).
12. **Runbooks** (`docs/runbooks/`): deploy; on-device debugging (remote inspection, `/diag`, `/lab`, fixture capture and iOS share-sheet export in the field); OPFS inspection and `.corrupt` recovery; close out any spec drift discovered while building.

## Verification

- CI: full unit + tiered fixture regression + GPU golden + full-loop + storage contract (both engines) + offline and E2E Playwright suites green.
- Manual: device-matrix checklist (incl. on-device self-test) signed off on Android phone + desktop Chromium (iOS best-effort); field acceptance report; cross-device round trip verified.

## Risks retired

- **Data loss from origin-scoped storage** — persist() surfacing and the nudge complete the backup story whose foundation (working export, iOS guidance) shipped in Phase 6 before anyone depended on the data.
- **Stale or broken offline behavior** — the SW path has been exercised since Phase 1; this phase proves the complete offline product loop.
- **Import as a corruption vector** — courses-first ordering, version refusal, orphan handling, and fuzzing make merge safe against both bugs and hostile files.
- **Unverified real-world accuracy** — the field protocol closes the loop on the ±1-frame claim with stopwatch/video ground truth across real sessions.
