# Phase 6 — Persistence and product UI: storage seam for real, courses, calibration, review

## Goal

The v1 product flows exist and data is durable: create courses, fly persisted sessions that survive a mid-session tab kill (losing at most the last lap), calibrate through a productized setup screen prefilled from the course's latest session, review sessions and all-time course records — and **export works**, because from this phase on real data exists that origin-scoped storage can silently lose. The schema contract (including the export envelope) is frozen before the first real byte is written.

**Mid-phase demoable checkpoint (after items 1–6):** fly a persisted session, kill the tab mid-session, reopen, laps survive. That is the emotionally significant durability moment and needs none of the review UI — do not let it slide to the end of the largest phase.

## Scope

**In:** schema contract (envelopes, validators, migrations — around the already-frozen Phase 4/5 domain shapes), Storage interface + MemoryStorage + OpfsStorage with contract tests, live-session write path with never-block proof, **working exportAll**, iOS install-before-data guidance (per the Phase 2 partitioning ADR), course CRUD, productized setup/test/armed screens, session and course review views, `persist()` surfacing.

**Out:** import, share-sheet export delivery polish, fuzz tests, backup nudge (Phase 7). **Desktop layout pass — moved to Phase 7**, where desktop's actual story (import-and-review) exists. PWA/offline hardening, install-flow UI (Phase 7).

## Work items (dependency order)

1. **Schema contract, before any file exists:** the Course/Session/Lap shapes are already frozen and field-validated (Phases 4–5); this item wraps them: `schemaVersion` envelopes per `storage.md`; runtime validators on **every** read path (never trust disk); migration registry of vN→vN+1 pure functions applied on read, current version written on save — shipped with a synthetic v0→v1 round-trip test proving the mechanism before it's needed. **Decide the export-envelope-vs-file schemaVersion relationship now** (recommend one global schema version; document in `storage.md`) — envelope versioning is part of the contract, not a Phase 7 afterthought. Enumerate the app-level settings object `storage.md` mentions but never specifies (recommend minimal: `lastExportAt`, speech on/off, last-used course); update `storage.md`.
2. **Storage interface** (minimal): loadCourses/saveCourses, listSessions (summaries), loadSession/saveSession, latest-session-for-course query, **exportAll (implemented this phase)**, importAll stub, persistenceStatus; explicit error taxonomy (NotFound, Corrupt, QuotaExceeded, WriteFailed). **MemoryStorage** + a contract test suite written against the interface — the fake is the workhorse for all UI and E2E tests.
3. **Atomic-write ADR, citing Phase 2's measured device behavior** (abort / never-close / tab-kill results on the real Android phone — not inference): the spec's "write-temp-then-rename where OPFS allows" is not portably implementable (`FileSystemFileHandle.move()` is Chromium-only; sync access handles are worker-only). v1 mechanism: `createWritable()` swap-file commit-on-close semantics, with any iOS quirks Phase 2 surfaced handled best-effort (ADR 0006). Record the ADR; amend `storage.md`.
4. **OpfsStorage:** `createWritable` exclusively; corrupt/truncated-file quarantine (rename aside as `<name>.corrupt.<ts>`, warn, continue — one bad session file must never brick the app); startup sweep for stale swap/orphaned files; Web Locks single-writer guard (second tab gets read-only / "session active in another tab" — spec gap, decided here); `navigator.storage.persist()` requested on first meaningful write, status surfaced in UI. Contract suite runs against OpfsStorage in **real Chromium** (gating) and WebKit (informational, ADR 0006) via the Phase 1 rig, plus crash-simulation tests (abort mid-write → previous content intact). Document: no session index file in v1; course views full-scan `sessions/`.
5. **Live-session write path:** rewrite only that session's file after each lap; detectionConfig snapshot persisted at arm time (decide file-creation moment: recommend at arm, so a zero-lap crash leaves a recoverable record — spec gap, document); async single-flight saves with latest-wins coalescing, retry with backoff — a slow or failed write must **never** delay lap timing or speech; unsaved-state surfaced after Stop, not mid-flight; QuotaExceeded path exists. Discard-last-lap mutates status and rewrites; verify records treat it as a window break end-to-end. **The never-block contract gets a test:** extend the Phase 5 full-loop CI test with a deliberately slow/failing Storage fake, asserting lap events and announcement decisions are byte-identical to the fast-storage run.
6. **Working export + iOS data-safety guidance:** exportAll assembles `{ schemaVersion, courses, sessions }` per item 1's envelope decision, delivered via anchor download (share-sheet polish is Phase 7 — but reuse the recorder's Phase 3-proven share path on iOS if trivial). Ship the Phase 2 partitioning ADR's consequence: if the installed PWA's OPFS is partitioned from the Safari tab (the expected answer), a one-line **"install before recording data" banner on iOS in tab context**, with export as the sanctioned migration/backup path. Dogfooding data accumulated from here on is no longer one site-data-clear or eviction away from oblivion. *(← mid-phase checkpoint lands here.)*
7. **Runes bridge pattern extension:** `.svelte.ts` repository modules wrapping the framework-free storage layer with `$state` — extending the Phase 3-established bridge rule (per-frame → canvas; low-frequency → `$state`) to storage-backed screens, as THE pattern for the rest of the UI.
8. **Course CRUD screens** (name, direction, min lap time; deletion out of scope per spec); home/course-list navigation.
9. **Setup screen productized:** port the `/lab` calibration overlay — camera preview, touch ROI drag/resize (normalized coords), live strip bars + trigger line, sensitivity controls, auto-suggested trigger, orientation binding per the Phase 3 decision; config prefill from the course's most recent session; then test mode and armed screens integrated into the product flow (reusing Phase 5 components).
10. **Session view** (persisted: lap table, highlights, strikethrough, header with course/date/note/records; note editing) and **course view** (all-time records across sessions, session list with summaries). Phone-first CSS only; the desktop layout pass moves to Phase 7 with the desktop import story.
11. **Fixture recorder audit:** confirm the debug recorder still exports via share/download or a dev-only channel — not ad-hoc OPFS calls violating the seam.

## Verification

- Contract suite green against MemoryStorage (node) and OpfsStorage (Chromium; WebKit informational), including crash-simulation and quarantine tests; slow-storage never-block test green.
- Manual on-device: create course → calibrate → test → arm → fly → kill the tab mid-session → reopen: session present, at most last lap lost. Prefill works. Records and highlights correct across discards. Export file downloads and contains the envelope + all data. If iOS is being exercised: tab context shows the install-before-data banner.
- Component tests for review screens against MemoryStorage.

## Risks retired

- **Schema churn after real data exists** — envelopes, validators, migration pipeline, and the export envelope all exist before the first file; the domain shapes themselves were frozen and field-validated in Phases 4–5.
- **Unbacked-up dogfooding data / iOS partitioning stranding** — working export and the install-before-data guidance land the same phase durable data begins, per the Phase 2 decision.
- **Non-portable atomicity assumption** — resolved by ADR grounded in Phase 2's on-device measurements, with crash tests in the browser rig.
- **Torn/corrupt files bricking the app; multi-tab clobbering** — quarantine + Web Locks land with the first writes.
- **Write stalls corrupting the timing experience** — the never-blocking save contract is designed with the session engine *and proven by a CI test*, not merely stated.
- **Calibration UX** — productized only after tunables were validated in Phases 3–4.
- **Phase-length demoralization** — the durability demo arrives mid-phase, not after the full review UI.
