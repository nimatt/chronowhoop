# Product spec

## Concepts

- **Course** — a physical track layout, reusable across sessions. Owns: name, crossing direction (which way through the gate counts), minimum lap time (default 3 s), created date.
- **Session** — one visit/flying stint on a course. Owns: start time, free-text note, a snapshot of the detection config actually used, and the ordered list of laps.
- **Lap** — duration (ms), wall-clock time of day when completed, and status (`valid` | `discarded`).

A course can have any number of sessions. Deleting is out of scope for this spec revision except discarding laps.

## Session lifecycle

1. **Setup** — user picks a course (new sessions prefill detection config from the course's most recent session), positions the camera, adjusts the ROI and sensitivity with a live overlay showing per-strip motion energy and the threshold.
2. **Test mode** — detection runs but records nothing; every detected valid crossing gives immediate audio feedback (no minimum-lap-time debounce in test mode — rapid hand-waves each get feedback; wrong-direction crossings stay silent). Used to verify setup by hand-wave or fly-through.
3. **Armed** — the first valid crossing starts the clock (it completes no lap). Each subsequent valid crossing completes a lap and immediately starts the next.
4. **Stopped** — manual stop only. An in-progress (incomplete) lap is dropped.

A Screen Wake Lock is held for the whole camera-active flow (setup through stopped), not only while armed — long calibration must not dim the screen. Wake-lock loss is surfaced in the UI.

Crossings in the wrong direction are ignored. Crossings closer together than the minimum lap time are ignored (debounce — measured from the last accepted crossing; ignored crossings don't extend the window). A **discard last lap** control marks the most recent lap `discarded` (used after crashes, walk-throughs, false triggers); timing of the current lap continues unaffected.

Interruptions while armed: if the page is hidden (call, notification, app switch), camera capture and detection stop with it — the session stays armed and timing continues, crossings during the gap are simply missed, and on return a dismissable notice says detection was interrupted. If the camera stream dies while armed (device lost, permission revoked, camera claimed elsewhere), the failure is surfaced prominently and the session stops automatically with its completed laps retained — never a silently dead pipeline behind a running clock.

## Records

- **Best lap** — minimum duration over valid laps.
- **Best three consecutive** — minimum sum over every window of 3 successive valid laps. A discarded lap breaks consecutiveness: windows cannot span it.
- Both are shown per session and all-time per course (across all its sessions). Best-three windows never span a session boundary — laps in different sessions are not consecutive, so the course all-time best three is the best within-session window across its sessions. Records are always computed from lap data, never stored.

## Speech feedback

Spoken via the Web Speech API (English, slightly elevated rate), terse so announcements don't overlap short laps:

- Lap completed: tenths precision — 14.32 s → "fourteen three".
- New session-best lap: prefix "best" — "best fourteen one".
- New session-best three consecutive: "best three" after the lap time.
- Test-mode crossing: short confirmation sound/word.

Announced times are rounded to the nearest tenth, half up (14.35 → "fourteen four"). "Best" / "best three" are announced only on improvement over an existing session record: the first valid lap and the first-ever three-lap window are not announced as records, and a tie never announces.

If an announcement arrives while one is speaking, it is queued; only the newest queued announcement survives (older queued ones are dropped). Speech is never cut off mid-word. A stuck speech engine is skipped after a timeout so announcements cannot wedge.

A speech on/off toggle (a stored app-level setting, default on) silences lap announcements only; test-mode confirmation beeps are setup feedback, not speech, and are unaffected.

## Session view

Table of all laps: lap number, duration (two decimals displayed; true resolution is camera-frame granularity, ±1 frame), time of day, status. Best lap and the best-three-consecutive window are visually highlighted. Discarded laps are shown struck through, not hidden. Session header shows course name, date, note, and both records; course view shows all-time records and the session list.

## Storage & portability

All data is JSON in the browser's origin-private file system — see `storage.md`. Export produces a file via download/share sheet; import merges on another device. No backend, no account.

## Platform requirements

Phone-first (device propped beside the gate), desktop supported for both timing and review. Requires WebCodecs camera capture (`MediaStreamTrackProcessor`), `getUserMedia`, OPFS, Web Speech synthesis (ADR 0009 — WebGPU is no longer required). Supported platforms: Android Chrome (primary) and desktop Chromium. iOS Safari 26+ is best-effort — kept working when feasible, never gating (ADR 0006). Unsupported browsers get an explanatory error screen. Installable PWA; fully offline after first load.

## Non-goals (v1)

- Multiple pilots / per-pilot records
- racegow.com submission integration
- Alternative capture routes beyond WebCodecs (the detection-source seam exists; a canvas-based iOS fallback is a candidate, not a v1 goal — ADR 0009)
- Cloud sync (storage interface is the seam)
- Per-crossing video capture (frame ring buffer is the seam)
