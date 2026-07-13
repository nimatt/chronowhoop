# Field acceptance protocol (Phase 7 exit item)

Closes the loop on the ±1-frame accuracy claim (ADR 0003, `detection.md`
Known limitations) with real flights and independent ground truth. This is a
written protocol with recorded results, not CI.

## Setup

- **N ≥ 3 real flight sessions**, real tiny whoop, real gate, on the deployed
  URL with the S22 (the gating device). Vary conditions across sessions where
  possible: indoor/outdoor light, gate distance, lap length (include laps
  short enough to stress announcement timing, ~5 s).
- Per session: create/reuse a course, calibrate (ROI + trigger suggestion),
  verify with test mode, arm, fly ≥ 5 laps, stop.
- **Ground truth, two independent sources per session:**
  1. A manual stopwatch operator (coarse cross-check, catches gross errors
     and missed/extra laps).
  2. A second phone recording video of the gate at a known frame rate,
     positioned to see the gate plane; lap times derived afterwards by
     frame-stepping the crossings.

## What to record (per session)

| Field | |
|---|---|
| Date, venue, lighting | |
| Build id | |
| Course (direction, min lap) + tunables snapshot (in the session file) | |
| Delivered camera fps (frame-loop panel before flying) | |
| App laps: count + durations (export afterwards — the session file is the record) | |
| Spoken announcements heard vs laps flown (missed / late / overlapping) | |
| Stopwatch laps | |
| Video-derived laps (frame-by-frame) + the video's fps | |
| False triggers / missed crossings, and what caused them (pilot walking, lighting step, prop wash…) | |

## Pass criteria

- **Accuracy:** every app lap duration within **±1 frame interval of the
  delivered rate** of the video-derived duration — ≈ ±17 ms at 60 fps, ≈
  ±33 ms at 30 fps (the claim follows the delivered rate; record which). The
  video ground truth carries its own ±1-frame reading error at the video's
  rate: an app-vs-video delta within the *sum* of the two frame intervals is
  a pass; investigate anything beyond it.
- **Completeness:** no missed valid crossings, and any false trigger is
  recoverable in-flow (discard last lap) — a false trigger that corrupts
  subsequent timing fails the session.
- **Speech:** every valid lap announced, intelligible over the running whoop,
  never overlapping into uselessness on the shortest laps.
- **Cross-device round trip (once, any session):** export on the phone via
  the share sheet → import the file on desktop Chromium → import counts match
  (all sessions/courses added or already present, none dropped) → course
  records, session lap tables, and best/best-three highlights identical to
  the phone's.

Result: a short report next to this runbook (date, table above per session,
pass/fail per criterion) — the roadmap's field-acceptance sign-off.

## Fixture harvesting (do this during every field session)

Any false trigger or missed crossing must come home as a replayable clip —
that is how field problems become CI regressions (tiered per `detection.md`
Fixture formats).

1. Open `/lab` on the device (same camera/ROI/tunables — the Tunables panel
   mirrors the product's), or reproduce the scene after the flight session.
2. Recorder panel: **Record** captures continuously and keeps the **first**
   ~30 s (1800 frames at 60 fps) — at the cap it stops adding frames and marks
   the clip truncated, so start it just before the event; **Snapshot ring**
   grabs the recent ring buffer and is the after-the-event tool. Both download
   a `.cwclip` (raw luma, lossless).
3. Get the file off the device via the share sheet / Files. Fill in the
   clip's `conditions` (venue, light, camera) when committing.
4. Annotate ground-truth crossings with the Annotation stepper (frame
   index + direction sidecar JSON); tier it `must-pass` if the current
   detector handles it, `known-limitation` if it does not (hard cases commit
   without breaking CI and are ratcheted in when solved).
5. Keep committed clips small — repo fixture budget ≤ ~5 MB total; long
   recordings stay out of the repo.
