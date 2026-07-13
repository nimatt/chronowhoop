# Phase 8 — UI alignment with docs/mockups/ui-mockups.html

## Goal

The shipped screens match the committed mockups' design language and per-screen
compositions. Behavior stays as specced (product.md et al.); the only behavioral
additions are the small ones the mockups embed (noted below).

## Source of truth

`docs/mockups/ui-mockups.html` — design tokens (phone-internal palette: ground
`#0a0e13`, panel `#131922`/`#1b2431`, line `#27313f`, ink `#eaeef4`, dims, signal
cyan `#33decf` for live detection/armed, record amber `#ffb84d` for bests, danger
red `#ff5265` for stop), mono numerals/labels, cards/chips/segmented controls/
steppers/sliders/FAB/toast/pulse patterns, and eight screen compositions.
The mockup predates ADR 0009 in one spot: the unsupported screen's "WebGPU" row
reads as today's WebCodecs capability; guide text follows the shipped gate.

## Work items

1. Design tokens + base styles (App.svelte globals) + shared components
   (AppBar/back button, Chip, RecTile records pair, buttons, energy-meter frame
   with trigger label, form field/segmented/stepper/slider styles).
2. Home: course cards with inline all-time records + meta, persisted chip,
   import/export icon buttons, "New course" FAB.
3. Course form: segmented direction control (arrow glyphs), min-lap 0.5 s stepper.
4. Course view: subtitle (direction · min lap), dated all-time records card,
   "Start session" primary CTA, session cards (date · laps · session best · note
   snippet).
5. Fly setup ("Calibrate"): styled preview + ROI handles + direction chip, meter
   with strip count + trigger line label, sensitivity row with trigger value
   readout, session-note field (BEHAVIOR: prefilled from the course's latest
   session note, passed to arm — product.md gains a sentence), Test-mode ghost CTA.
6. Test mode: "records nothing" subtitle, crossing toast + screen-edge flash on
   detection, LIVE dot, amber full-width ARM.
7. Armed: pulsing ARMED badge, wake-lock "Awake" chip, huge mono current-lap
   clock, 3-stat grid (last/best-amber/laps), ghost Discard + big red STOP.
8. Session review (SessionView + FlyStoppedPanel table): header card (date, italic
   note, record tiles), mono lap table with time-of-day, amber best row + bracketed
   best-3 band, struck discards, "discarded" tag.
9. Unsupported: warn mark, per-capability probe rows (pass/fail), guidance box
   (WebCodecs wording per ADR 0009).

## Constraints

- No behavior changes beyond items 5's note prefill (spec updated in-change).
- Test hooks (asserted strings/classes) preserved or tests updated deliberately.
- Per-frame rules unchanged (bars/clock stay direct-draw).
- Desktop breakpoints from Phase 7 preserved.

## Verification

Full gates green; browser screenshots of each screen reviewed against the mockups.
