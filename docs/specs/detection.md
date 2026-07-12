# Detection pipeline spec

Camera side-on to the gate; user crops a region of interest (ROI) around the gate opening. Goal: detect the moment a tiny whoop crosses the gate plane, with direction, at ±1 camera frame accuracy.

## Capture (ADR 0009)

- `getUserMedia`, rear camera preferred on phones; request 60 fps, accept what the device gives (auto-exposure may halve delivered rate in low light — accuracy follows the delivered rate).
- Frames arrive as WebCodecs `VideoFrame`s via `MediaStreamTrackProcessor` — no video element, no canvas in the capture path. Only the ROI is copied out (`copyTo` with a crop rect), and the Y plane is read directly as luminance for the planar formats Android cameras deliver (NV12/I420), stride-subsampled to a fixed working resolution (target ~256 px wide) so cost is independent of camera resolution.
- Each processed frame is timestamped with `VideoFrame.timestamp` — a capture timestamp by construction; lap boundaries use these timestamps, not processing-completion time.
- All capture-API use lives inside the detection module (`src/core/detection/`, lint-enforced seam); the rest of the app consumes `FrameSample`s only.

## Reduction stage (CPU, per frame)

1. Subsampled ROI luminance (from the Y plane; packed-RGB formats convert during subsampling).
2. Diff against a background model: exponential moving average of past luminance frames. The EMA updates slowly, and updating is paused while a crossing is in progress so the drone doesn't get absorbed into the background.
3. Threshold the absolute difference into a binary motion mask.
4. Divide the ROI into **N vertical strips** (default 12) along the travel axis; reduce the mask to one motion-energy value (hot-pixel count) per strip.
5. Emit one `FrameSample` `{ captureTimeMs, energies }` per frame. This tiny per-frame record is the entire pipeline→state-machine interface.

The reduction makes no decisions — it only reduces frames to strip energies. It is pure TypeScript, so golden tests, replay, and the full detection loop run deterministically in node.

## CPU stage (TypeScript state machine)

Consumes the per-frame strip-energy vector plus timestamp. Detects a **crossing** as a motion wave traversing the strips:

- Track which strips are "hot" (energy above trigger level) per frame.
- A crossing = hot region entering at one edge and progressing to the other within a plausible time window; direction = order of traversal.
- Emit `crossing(timestamp, direction)` events. Crossing timestamp = capture time of the frame where the wave reached the gate-center strips.

Above that, the session layer applies the semantics from `product.md`: arming, direction filter, minimum lap time debounce, lap emission.

The state machine is pure TS with no GPU dependency and is unit-tested against synthetic and recorded strip-energy sequences. Recording real sequences to JSON fixtures from a debug flag is part of the design.

## Calibration UX

Setup screen renders: camera preview, draggable/resizable ROI rectangle, live per-strip energy bars with the trigger-level line, and sensitivity controls. Test mode (see product spec) confirms end-to-end detection before arming.

## Tunables

Snapshotted into each session (seeded from the course's previous session):

| Parameter | Default | Notes |
|---|---|---|
| ROI rect | — | normalized to camera frame |
| Strip count | 12 | along travel axis |
| Trigger level | auto-suggested | from observed background noise, user-adjustable |
| EMA alpha | ~0.05 | background adaptation speed |
| Min lap time | 3 s | lives on the course |
| Direction | — | lives on the course |

## Video-capture seam

The pipeline keeps a short ring buffer of recent downscaled ROI frames. v1 uses it for nothing user-facing, but per-crossing clip export must be addable later purely by consuming this buffer on `crossing` events.

## Known limitations

- Accuracy is bounded by camera frame interval (~17–33 ms). Constant per-setup bias cancels out between laps of the same session.
- Two objects moving through the ROI simultaneously (pilot walking during flight) can confuse the wave detector; direction + min-lap-time filtering mitigates, discard-last-lap recovers.
- Large lighting changes (clouds, lights toggling) may need a moment of background re-adaptation; test mode reveals this.
