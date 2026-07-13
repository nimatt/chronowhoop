# Device-matrix smoke checklist (manual, release-gating by sign-off)

The manual half of Phase 7 verification (plan 07 item 10): everything
automation cannot see — real cameras, real speech engines, real thermals, real
process kills. Run from the **deployed URL** (https://chronowhoop.com), never
a dev server, and note the build id (bottom of `/diag`, or the `__BUILD_ID__`
git hash) with the results.

Post-ADR-0009 there are no GPU items: the pipeline is CPU over WebCodecs
capture, and the numeric on-device check is the `/lab` self-test (CPU).

## Devices

| Column | Device | Status |
|---|---|---|
| **A** | Android Chrome — Samsung Galaxy S22 (the ADR 0008 hard-requirement device) | **gating** |
| **B** | Desktop Chromium (Linux or macOS) | **gating** |
| **C** | iOS Safari 26+ device | best-effort (ADR 0006), and currently **blocked**: iOS Safari has no `MediaStreamTrackProcessor`, so the capture flow cannot run — only the review/import items and the gate-exempt `/lab` self-test apply; run them when a device is available |

Mark each cell ✅ / ❌ / n/a, with a note for anything not a clean pass. A ❌ in
column A or B blocks release sign-off.

## Checklist

| # | Item | How | A | B | C |
|---|---|---|---|---|---|
| 1 | Real rear camera at granted fps | `/diag` → Frame loop panel with the rear camera: granted fps ≥ 60 target (30 floor, 2 % tolerance per ADR 0008); no sustained drop over the panel's window | ☐ | ☐ | n/a |
| 2 | CPU self-test passes | `/lab` → Self-test panel: PASS (bundled clip replays bit-exact against the committed energy JSON — the deployed bundle computes what CI computed) | ☐ | ☐ | ☐* |
| 3 | `/diag` probe panels | WebCodecs capture (CPU pipeline (WebCodecs): rate ≈ camera rate, total ≤ ½ frame interval), Speech probes, Storage (OPFS) atomic-write probes, Wake lock. **These are also the still-owed ADR 0008 S22 rows — transcribe the numbers into ADR 0008 while here** | ☐ | ☐ | ☐ |
| 4 | TTS timing on short laps | Fly a course with laps ~5 s: every lap announced, terse, never overlapping the next announcement; "best"/"best three" only on improvement | ☐ | ☐ | n/a |
| 5 | Share-sheet export | Home → Export data: share sheet opens with the JSON file on the phone (anchor download on desktop); file content is the full envelope | ☐ | ☐ | ☐ |
| 6 | Wake lock through a session | Screen stays on from camera start through a full armed session (setup → stopped); any wake-lock loss is surfaced in the UI, never silent | ☐ | ☐ | n/a |
| 7 | Background/foreground while armed | Switch apps (or take a call) mid-armed-session, return: session still armed, dismissable "detection was interrupted" notice, next crossing records | ☐ | ☐ | n/a |
| 8 | Camera/track death while armed | Revoke camera permission (or claim the camera elsewhere) mid-session: session auto-stops with completed laps retained, failure surfaced prominently | ☐ | ☐ | n/a |
| 9 | Orientation-change warning | Start the camera, rotate the device: prominent rotate-back warning, Arm/Test disabled; while armed, a crossing during the mismatch is NOT recorded; rotate back: warning clears, interruption notice shows, detection records again | ☐ | ☐ | n/a |
| 10 | 20-minute thermal/battery soak | Camera + armed session running 20 min: no thermal shutdown, no sustained fps collapse (re-check the frame-loop rate at the end), no dropped wake lock, battery drain noted | ☐ | ☐ | n/a |
| 11 | Installed-PWA offline relaunch | Install to home screen, load once, enable airplane mode, kill and relaunch from the icon: app loads, a full timing session works end to end (camera, laps, speech, save) | ☐ | ☐ | ☐† |
| 12 | Tab-kill durability | Arm, fly ≥ 2 laps, kill the tab/app from the task switcher mid-session, reopen: session listed with at most the last lap lost | ☐ | ☐ | n/a |

\* iOS: `/lab` is capability-gate-exempt and the self-test is pure TypeScript
over the bundled clip — no `MediaStreamTrackProcessor` involved — so it
genuinely runs on iOS Safari 26+ and is the only runnable numeric check there;
record its PASS/FAIL.

† iOS: product flow — expected blocked by MSTP at the unsupported-browser
gate (the gate should say so clearly; that render IS the iOS result to
record).

## Sign-off

| Field | Value |
|---|---|
| Build id | |
| Date / tester | |
| Column A device + OS/Chrome versions | |
| Column B device + OS/Chromium versions | |
| Result | pass / fail (link failing rows) |

File deviations as spec/plan issues; do not soften a row to make it pass —
the thresholds live in ADR 0008 and this checklist only points at them.
