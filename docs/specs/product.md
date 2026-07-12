# Product spec

## Concepts

- **Course** — a physical track layout, reusable across sessions. Owns: name, crossing direction (which way through the gate counts), minimum lap time (default 3 s), created date.
- **Session** — one visit/flying stint on a course. Owns: start time, free-text note, a snapshot of the detection config actually used, and the ordered list of laps.
- **Lap** — duration (ms), wall-clock time of day when completed, and status (`valid` | `discarded`).

A course can have any number of sessions. Deleting is out of scope for this spec revision except discarding laps.

## Session lifecycle

1. **Setup** — user picks a course (new sessions prefill detection config from the course's most recent session), positions the camera, adjusts the ROI and sensitivity with a live overlay showing per-strip motion energy and the threshold.
2. **Test mode** — detection runs but records nothing; every detected valid crossing gives immediate audio feedback. Used to verify setup by hand-wave or fly-through.
3. **Armed** — a Screen Wake Lock is held; the first valid crossing starts the clock (it completes no lap). Each subsequent valid crossing completes a lap and immediately starts the next.
4. **Stopped** — manual stop only. An in-progress (incomplete) lap is dropped.

Crossings in the wrong direction are ignored. Crossings closer together than the minimum lap time are ignored (debounce). A **discard last lap** control marks the most recent lap `discarded` (used after crashes, walk-throughs, false triggers); timing of the current lap continues unaffected.

## Records

- **Best lap** — minimum duration over valid laps.
- **Best three consecutive** — minimum sum over every window of 3 successive valid laps. A discarded lap breaks consecutiveness: windows cannot span it.
- Both are shown per session and all-time per course (across all its sessions). Records are always computed from lap data, never stored.

## Speech feedback

Spoken via the Web Speech API (English, slightly elevated rate), terse so announcements don't overlap short laps:

- Lap completed: tenths precision — 14.32 s → "fourteen three".
- New session-best lap: prefix "best" — "best fourteen one".
- New session-best three consecutive: "best three" after the lap time.
- Test-mode crossing: short confirmation sound/word.

## Session view

Table of all laps: lap number, duration (two decimals displayed; true resolution is camera-frame granularity, ±1 frame), time of day, status. Best lap and the best-three-consecutive window are visually highlighted. Discarded laps are shown struck through, not hidden. Session header shows course name, date, note, and both records; course view shows all-time records and the session list.

## Storage & portability

All data is JSON in the browser's origin-private file system — see `storage.md`. Export produces a file via download/share sheet; import merges on another device. No backend, no account.

## Platform requirements

Phone-first (device propped beside the gate), desktop supported for both timing and review. Requires WebGPU, `getUserMedia`, OPFS, Web Speech synthesis: Chromium desktop/Android, Safari 26+. Unsupported browsers get an explanatory error screen. Installable PWA; fully offline after first load.

## Non-goals (v1)

- Multiple pilots / per-pilot records
- racegow.com submission integration
- CPU fallback detection pipeline
- Cloud sync (storage interface is the seam)
- Per-crossing video capture (frame ring buffer is the seam)
