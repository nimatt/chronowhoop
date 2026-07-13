# Phase 8 UI alignment — implementation notes

Working notes per wave for docs/plans/08-ui-mockup-alignment.md. Source of
truth: docs/mockups/ui-mockups.html (phone-internal palette only — the
gallery-shell `--pg-*` tokens don't apply to the app).

## Wave A — tokens, globals, shared components

### Global vocabulary (App.svelte `:global` block)

Tokens on `:root`: `--c-ground/-panel/-panel2/-line/-ink/-dim/-dim2/-signal/
-signal-dim/-record/-record-dim/-danger`, `--font-mono`, `--font-sans` —
mockup verbatim. Body is ground/ink/sans; links are signal cyan;
`:focus-visible` is a cyan outline; `* { box-sizing: border-box }` is now
global (the mockup layout assumes it; verified no existing screen shifted).

Global classes (mockup CSS verbatim unless noted):

- Typography: `.mono`, `.label`, `.hint`, `.caret`
- Icons: `.ic` (19px), `.ic-sm` (15px) — stroke-styled SVG classes for icon
  snippets; `display: block` is on the classes, not bare `svg`
- Layout: `.card`, `.stack`, `.list` (mockup's `overflow: hidden` dropped —
  it was phone-frame clipping, and it would eat focus rings)
- Buttons: `.btn`, `.btn-primary`, `.btn-warm`, `.btn-ghost`, `.btn-danger`,
  `.btn-stop`, plus `.fab` (mockup absolute → `position: fixed`, the app has
  no phone frame). Added `cursor: pointer` and `:disabled { opacity: .45 }`
  (mockups are static and have no states)
- Fields: `.field`, `.field .val`, `.field .val.mono`, `.seg`/`.opt`/`.sel`/
  `.arw`, `.stepper` (+ button/`.n`/`small`)
- Sliders: `.slider`/`.fill`/`.knob` (custom, mockup verbatim) AND
  `input[type=range].slider-native` for the app's real range inputs: cyan
  22px thumb + halo, 8px line-colored track, `accent-color`. Judged honestly:
  Chromium cannot paint the filled-before-thumb track portion in CSS alone,
  so `.slider-native` tracks are uniform there (Firefox gets the fill via
  `::-moz-range-progress`). Screens that want the exact mockup fill must
  build the custom `.slider` with a bound width — not required for Wave A
- Review table (all prefixed `.table` so diag/lab tables and the current
  LapTable markup are untouched): `.table`, `.table th/td`,
  `.table tr.best td`, `.table tr.b3band td`, `.table tr.b3band.first td`,
  `.table tr.discarded td`, `.lap-num` + `.bar-i`, `.table td .tod`,
  `.disc-tag`, `.b3label`
- `.flashborder` — test-mode screen-edge flash, `position: fixed; inset: 6px`
  (viewport edge stands in for the mockup's bezel)
- Notices: `.notice-error` / `.notice-warning` re-tokened to danger red /
  record amber

### Shared components (src/ui/shared/)

- `AppBar.svelte` — props `title`, `subtitle?`, `subtitleTone?: 'signal' |
  'dim'` (test mode's dim "Records nothing" sub), `backHref?` (renders an
  `<a class="backbtn">`), `onback?` (renders a `<button>`; wins over
  backHref), `actions?: Snippet` (right side, put IconButtons in it)
- `IconButton.svelte` — props `label` (aria-label/title), `accent?`,
  `disabled?`, `onclick?`, `children: Snippet` (the icon, e.g.
  `<svg class="ic">`)
- `Chip.svelte` — props `variant?: 'ok' | 'warm'`, `icon?: Snippet`,
  `children: Snippet`, `class?` passthrough for positioning (declare such
  classes `:global` in the consumer, e.g. the preview dirchip)
- `RecTiles.svelte` — props `bestLapMs?`, `bestThreeMs?` (numbers, ms;
  undefined → dim em dash), `bestLapLabel?` (default "Best lap"),
  `bestThreeLabel?` (default "Best 3"; CourseView passes "Best 3
  consecutive"), `bestLapMeta?`/`bestThreeMeta?` (mono date line under the
  value). Formatting lives in `rec-format.ts` (`recTileValue`, node-tested);
  reuses `formatLapSeconds`
- `MeterFrame.svelte` — props `stripCount?` (head reads "Motion energy · N
  strips"), `label?` (overrides the composed head), `status?: Snippet`
  (right-side mono cyan), `triggerLevel?` (0–1; renders the amber "trigger"
  label as a CSS overlay at `bottom: level%`), `children: Snippet` (the bars
  canvas). The canvas keeps drawing bars + trigger line itself
  (energy-bars.ts, the per-frame channel); give it `display: block` and no
  margins inside the frame so the overlay label aligns with the drawn line
- `Toast.svelte` — props `icon?: Snippet`, `top?` (default '14px'),
  `children`. `position: absolute` like the mockup — the consumer's
  container provides the `position: relative` context

Component-scoped vs global: appbar/backbtn/iconbtn/chip/rec/meter/toast CSS
is scoped inside the components (the component is the API); only the classes
listed above are global. `StatusChips`/status bar skipped — that's OS chrome
in the mockup, not app UI.

### Other Wave A changes

- energy-bars.ts trigger line `#ffd27e` → `#ffb84d` (`--c-record`) and HUD
  text → `#eaeef4` (canvas can't read custom properties)
- index.html `theme-color` and the PWA manifest `theme_color`/
  `background_color` → `#0a0e13` (new ground)
- CapabilityList.svelte: scoped override neutralizing the global `.label`
  token class (its `.label` is body text); the only class-name collision
  found. `.hint` is used by diag/lab/fly — the global recolor to `--c-dim`
  is intentional and verified legible
- Diag/lab verified by screenshot after the swap: legible, no adjustments
  needed beyond the body-color inheritance they already had

### Deliberately not included (later waves)

`.course`/`.meta` course-card composite (Home wave), `.preview`/`.roi`/
`.dirchip`/`.rec-dot` (fly setup wave), `.armed-*`/`.pulse`/`.clock`/
`.statgrid` (armed wave), `.rev-head`/`.rev-recs` (compose from `.card` +
`RecTiles`), `.probe`/`.guide`/`.unsup` (unsupported wave), `.bars` div
styles (bars stay canvas-drawn).

## Wave B3 — lap table, SessionView, Unsupported

### LapTable (mockup 07)

- Adopts the global `.table` vocabulary (mono tabular numerals, right-aligned
  duration/time, `.lap-num` + `.bar-i`, `.tod` span, amber `tr.best`,
  `.b3band`/`.first` band, `.discarded` strike + `.disc-tag`).
- Class-hook strategy: the asserted test classes stay as the source of truth —
  `best` and `discarded` are the SAME names the global sheet styles, and
  `best-three` stays on window rows as a pure test hook with the visual
  classes `b3band`/`first` applied alongside (no CSS aliasing needed).
- The `.b3label` bracket ("◄ Best 3 consecutive · <total> s") sits ABOVE the
  window by splitting the markup into two `.table`s around a plain div, per
  the mockup. It is never a `<tbody>` row — tests (fly, e2e, review-views)
  count laps as `tbody tr`, and querySelectorAll order across the two tables
  matches lap order. `table-layout: fixed` + a shared colgroup keeps the two
  tables' columns aligned.
- Deviations, deliberate:
  - A 4th "Status" column is kept (dim `valid` / `.disc-tag` `discarded`) —
    fly/e2e tests assert the status words in row text, and we don't store a
    discard reason (the mockup's "crash" tag), so the status word IS the tag.
  - A small amber mono `best` tag next to the best duration — fly tests
    assert the word in the row.
  - The old "best three consecutive — N s total" legend line is kept
    (restyled as a dim centered `.hint`): fly.browser.test.ts asserts the
    exact string and that file belongs to the parallel wave.

### SessionView (mockup 07)

- AppBar: back to the course (home when unknown/not-found), title "Session",
  course name as the cyan subtitle — kept as a LINK (tests navigate via it),
  which needed a small additive AppBar prop `subtitleHref` (renders the
  `.sub` as an `<a>`, no underline until hover). Unknown course → plain
  "Unknown course" subtitle.
- Header `.card`: dim mono date (formatDateTime kept — locale-independent),
  the note as an italic cyan borderless textarea flanked by CSS quote glyphs
  (hidden while empty) — always-editable beats the mockup's static quoted
  line; Save button is the global `.btn.btn-primary`, appearing when dirty
  as before. RecTiles (Best lap / Best 3) replace RecordsSummary; the lap
  count moved out (it reads off the table).
- Lap table in a `.card` (mockup's 6px/4px padding), plus the dim caption
  under it whenever a discarded lap exists: "Lap N discarded — the best-3
  window can't span it" (plural-aware, derived, not stored).
- Desktop 48rem `.review-columns` grid preserved.

### Unsupported (mockup 08)

- Own probe-row rendering scoped in Unsupported.svelte (`.unsup`, `.warnmark`,
  `.probe`, `.guide` — mockup CSS verbatim); CapabilityList stays as-is for
  Diag. Probe copy keys off CapabilityName (ADR 0009: the mockup's WebGPU row
  is WebCodecs now): WebCodecs "detection capture", Camera "getUserMedia ·
  rear", Local storage "OPFS · sessions", Speech "lap announcements". Failing
  probes also show the report's detail line in danger red (field-support info
  the mockup omits).
- Headline "This browser can't run ChronoWhoop" + lead per mockup; guide box:
  "WebCodecs capture powers the motion detector. Open ChronoWhoop in
  <b>Chrome on Android</b> or <b>desktop Chromium</b>. iOS Safari currently
  lacks the required capture API." The diag link stays.
- app-gate.browser.test.ts updated: headline needle is now "can't run
  ChronoWhoop", per-capability assertions check `.probe.pass`/`.probe.fail`
  counts and the fail detail instead of the old PASS/FAIL text.

### Removals

- RecordsSummary.svelte deleted — after this wave (SessionView → RecTiles)
  and B1 (CourseView → RecTiles) it had no consumers.

## Wave B1 — Home, CourseForm, CourseView

### Home (mockup 01)

- AppBar "Courses" replaces the brand heading/tagline; Import/Export are
  IconButtons (mockup arrow-tray icons) driving the existing handlers — the
  hidden file input, notices (`role="status"`), and error copy are unchanged.
  Browser tests that used "Tiny-whoop lap timer" as the Home marker now wait
  for "Courses"; Export is found by aria-label.
- Persistence: `Chip(ok)` "Storage persisted" when persist() was granted;
  the standing not-granted warning stays, restyled as the global
  `.notice-warning`. The mockup only draws the good state.
- Course cards: whole card is the link (`.card.course.course-link`, chevron
  affordance), name + mono meta "N sessions · last flown Jul 11" (or "No
  sessions yet"), and RecTiles with the course's ALL-TIME records. Records
  need lap bodies, so Home does one full-scan pass per mount (refresh() +
  loadSession per summary, grouped per course) cached in component state —
  the v1 full-scan posture storage.md documents; recomputed after an import.
  Session count / last-flown come from the summaries; unreadable sessions
  are skipped silently here (CourseView reports them).
- Per-course Fly links REMOVED from Home — flying starts from the course
  view's "Start session" (mockup has no Fly on home). "New course" is the
  fixed cyan FAB (an anchor; global `.fab`). Install button kept as a small
  pill next to the chip; diag/lab footer links kept; empty state kept as a
  card ("create your first course" needle preserved).
- Desktop 48rem: two cards per row (grid), `align-items: start`.

### CourseForm (mockup 02)

- AppBar with back (backHref = cancel target: home for new, course view for
  edit); the two visible Cancel links are gone — back is the cancel.
- `.field`/`.label` vocabulary: name input is `.val`; direction is the `.seg`
  segmented control — two real `<button type="button" aria-pressed>` options
  with arrow glyphs and "counts this way" under the selected one (nbsp
  placeholder keeps heights stable). Toggle-button semantics chosen over
  role=radio (correct keyboard behavior for free).
- Min lap is the `.stepper` (− / mono "3.0 s" / +), 0.5 s steps, clamped ≥ 0,
  rounded to a tenth against float drift; `minLapSeconds` is now always a
  defined number so the old number-input validity hint is gone (nameValid is
  the only gate left). Seeded edit values display via toFixed(1) but save
  unrounded.
- Primary CTA "Create course" (new) / "Save" (edit), `.btn.btn-primary`,
  pinned to the bottom via flex column + min-height (mockup's margin-top:auto
  composition). Tests updated: seg-option click + stepper clicks replace
  select/number-input events; create flows use "Create course".

### CourseView (mockup 03)

- AppBar back + course name + cyan mono subtitle via `courseSubtitle()`
  ("Left → Right · min 3.0 s" — one decimal always; tests updated from
  "min lap 4.5 s"/"right → left" to "min 4.5 s"/"Right → Left"). Edit kept
  (mockup lacks it) as a small mono uppercase bordered link in the app-bar
  actions.
- "All-time records" `.card` with RecTiles ("Best lap"/"Best 3 consecutive")
  + per-tile mockup date meta ("Jul 11"): best-lap date from the record lap's
  completedAt, best-3 date from the window's LAST lap's completedAt. New
  locale-independent helpers in course-format.ts: `formatShortDate`,
  `formatShortDateTime` ("Jul 11 · 20:12"), `courseSubtitle`.
- "Start session" `.btn-primary` anchor (play icon) to the existing fly
  route, replacing "Fly" (e2e updated). Session cards: mono short date/time
  left, session-best amber "12.84 s" right, mono meta "N laps
  (M discarded) · note" — note snippet cyan italic, truncated at 64 chars.
  The "(M discarded)" parenthetical is kept from the old list (mockup omits
  it, but it carries real information and tests pin it). Empty-state copy now
  says "start a session" instead of "hit Fly".
- Read-only/error notices, skipped-sessions warning, not-found, and the
  full-scan-on-mount data flow are unchanged. RecordsSummary usage dropped
  (file deleted by Wave B3 once both consumers had moved to RecTiles).
- Desktop 48rem `.review-columns` grid preserved: records card + Start
  session in the left column, sessions right.

## Wave B2 — fly flow (Calibrate, Test mode, Armed, stopped header)

Behavior preserved except the flagged note-prefill addition. Every existing
gate/banner survives, re-tokened: read-only + saving-previous + orientation
(FlyFlow, now `.notice-warning`), interruption + camera-lost + audio/camera
errors (`.notice-error`/`.notice-warning`), wake lock, speech toggle.

- Per-panel AppBars replaced FlyFlow's header (each panel owns its mockup
  composition): setup "Calibrate" + cyan course subtitle, back → course view;
  test "Test mode" + dim "Records nothing", back = stopTestMode (the old
  "Back to setup" button is gone — tests click `[aria-label="Back"]`);
  stopped "Session over" + course subtitle, back → course view ("Session
  over" kept as the title so the many `waitForText('Session over')`
  assertions and the mounted-alone backup-nudge test stay pinned). Armed has
  no AppBar (leaving mid-flight stays deliberate); the explicit Course/Home
  nav links are gone — the back affordance is the navigation.
- Setup (mockup 04): `.preview` (rounded/bordered, real `<video>`) with
  Chip(ok) dirchip ("L → R"/"R → L", pointer-events none so ROI drags pass
  through) + RoiOverlay on top; MeterFrame around the bars canvas
  (stripCount from tunables, triggerLevel for the amber CSS label; status
  slot omitted — nothing cheap and honest to show); Sensitivity `.field`
  with right-side mono amber readout ("trigger 0.42" + " · auto" ONLY right
  after applying a suggestion, cleared on slider input — local `triggerAuto`
  state, judged the honest minimum); `.slider-native` range input;
  Start/Stop camera as `.btn-primary`/`.btn-ghost` row; Test mode
  `.btn-ghost` with play icon; ARM `.btn-warm` (casing changed Arm → ARM in
  both panels, tests updated). Course summary line (direction · min lap +
  Edit course) kept as a mono hint.
- **Session note (BEHAVIOR ADDITION)**: setup gains a `.field` note input
  (`input.val`, italic cyan) prefilled from the course's latest session's
  note. Wiring: Fly.svelte's one-shot prefill now carries
  `{ detectionConfig, note }` from `latestForCourse` → FlyFlow `initialNote`
  → createFlySession `options.initialNote` seeds the `note` state →
  `setNote` is now writable pre-arm (local only) → `arm()` passes it to
  `engine.arm(course, config, note)` (the engine already took a note param)
  so the session file starts with it. `newSession()` keeps the note (the
  just-flown session is now the latest = the next prefill). Stopped-panel
  note editing unchanged on top. product.md Setup step gained the sentence.
- Test mode (mockup 05): gains the same preview with LIVE `.rec-dot` and a
  non-interactive dashed-cyan `roi-ghost` (RoiOverlay would enable ROI drag
  mid-test — a behavior change, so visual-only); each crossing raises a
  transient (~1.2 s, restarted per crossing) cyan Toast ("Crossing · L → R")
  + global `.flashborder` — driven reactively off testCrossingCount, tests
  deliberately assert only the count (in the MeterFrame status slot,
  aria-live, "N crossings detected" string kept); big amber ARM
  (`.btn-warm`, mockup's 22px/1.35rem); armDisabled gating and suggest flow
  untouched.
- Armed (mockup 06): pulsing cyan `.armed-badge` (text stays literal "ARMED"
  for the test string; reduced-motion disables the pulse) + Chip(ok) "Awake"
  only when wakeLockState === 'active' (else WakeLockWarning shows, as
  before); centered `.clockwrap` with mono "Current lap" label — the clock
  stays the rAF-written span (`.clock` class and "· · ·" placeholder pinned
  by tests; the " s" unit is a sibling span gated on the reactive
  clockStarted so the clock text node stays pure); `.statgrid` Last lap /
  Session best (amber) / Laps; `.bigbtns` ghost Discard (trash icon) +
  `.btn-danger.btn-stop` STOP. Handlers/confirm semantics untouched.
- Stopped header (mockup 07): `.rev-head` card with mono date line
  (`sessionStartedAt`, a new non-reactive FlySession getter over
  engine.session.startedAt, + lap count), save-status lines, the note as the
  still-editable textarea styled italic cyan (display == edit; a separate
  display mode would add a state for nothing), RecTiles for session records
  (the old `.records` dl is gone — fly + e2e assertions moved to `.recs` /
  "Best lap"/"Best 3"). Nudge/save-status/export/New session kept,
  re-tokened. LapTable untouched (Wave B3).
- RoiOverlay: styles only — dashed cyan border, faint cyan wash, 8 square
  cyan handles (corner + edge-midpoint spans; midpoints are visual dressing,
  hit-testing still corners-or-move). The dark outside mask kept (functional
  on a live preview). WakeLockWarning re-tokened to `--c-record`.
- Test updates: Arm→ARM / Stop→STOP everywhere (fly, fly-orientation, e2e),
  "Calibrate" heading asserted, back-control helper replaces "Back to
  setup", `.records`→`.recs`, backup-nudge fake session gained
  course/sessionStartedAt, e2e's stopped-panel "Course" link click → the
  AppBar back anchor. New coverage: note prefill within a mount (New session
  keeps the note; re-arm seeds the new session file) and across a remount
  (Fly.svelte reads the stored latest note).

## Visual review

Method: throwaway browser spec (deleted after the pass) mounted the real App
over a seeded MemoryStorage (courses/sessions mirroring the mockup data,
including the 8-lap best-3+discard session) and the Fly screen over the fake
quiet-scene camera, at a 390px viewport; `page.screenshot` captures of Home,
CourseForm (new), CourseView, SessionView, Unsupported, and fly
setup/test/armed/stopped were judged against docs/mockups/ui-mockups.html.
Full `test:browser` re-run green after deleting the spec. Deviations already
recorded above as deliberate are not re-listed.

### Verdicts

- **Home — matches.** Cards (name, meta, chevron, RecTiles with exact
  `#0a0e13`/`#ffb84d` tokens), persisted chip, icon-button bar, FAB all match
  the mockup composition.
- **CourseForm (new) — matches**, one Low finding (below).
- **CourseView — matches.** Subtitle, dated records card, Start session CTA,
  session cards with amber session best + cyan italic note snippet.
- **SessionView — mostly matches**, two findings (below).
- **Unsupported — matches.** Warnmark, probe rows, guide box, ADR-0009 copy.
- **Fly test mode — matches** (toast, LIVE dot, ROI ghost, edge flash, meter
  status, big amber ARM), one Low finding (below).
- **Fly setup / Armed / Stopped — token-faithful**, findings below.

### Findings for a fixer

1. **Medium — best-3 bracket renders as amber ticks on every cell**
   (SessionView + FlyStoppedPanel tables). The `.first` band row shows a
   full-height amber bar at the LEFT EDGE OF EVERY td (4 ticks strewn across
   the row) because `.table tr.b3band.first td { box-shadow: inset 3px 0 0 }`
   (App.svelte global block) applies per cell; the design intent (◄ bracket)
   is a single left-edge marker. The mockup CSS shares the rule, but with the
   app's 4th Status column it clearly reads as a rendering bug. Fix hint:
   scope to `td:first-child`. File: src/ui/App.svelte (`.table tr.b3band.first td`).
2. **Medium — fly meter canvas is off-palette.** `drawStripBars` paints
   background `#16233c` and bars `#7ea6ff` (blue) — the mockup meter draws
   cyan bars (`--c-signal` hot / `--c-signal-dim` cold) on the panel ground,
   and blue violates the "cyan = live sensor data" color role. Only the
   trigger line/HUD were re-tokened in Wave A. Caveat: strip-bars.ts is
   shared with diag/lab panels. Files: src/ui/diag/strip-bars.ts (colors),
   src/ui/shared/energy-bars.ts (fly/lab wrapper).
3. **Medium — armed screen is top-stacked, not full-height.** Mockup 06
   spreads badge / huge clock / statgrid / bigbtns across the whole screen
   (`justify-content: space-between`) so STOP sits at thumb reach; the app
   leaves the bottom ~40% of an 844px viewport empty with STOP mid-screen.
   Fix hint: min-height flex column (the CourseForm `100dvh` pin precedent).
   File: src/ui/fly/FlyArmedPanel.svelte (plus its FlyFlow container).
4. **Low/Medium — setup screen overflows the phone viewport**; Test mode +
   ARM live below the fold (~340px overflow at 390×844). The mockup fits one
   screen; the app adds camera Start/Stop, drag hint, course line, suggest
   row, speech toggle. Real functionality — but worth compressing (e.g.
   camera row tighter, hints smaller/merged) so the primary actions are
   visible. File: src/ui/fly/FlySetupPanel.svelte.
5. **Low — SessionView note quotes/resize artifacts.** The closing `”`
   (CSS ::after on the flex row) renders at the card's far right edge,
   detached from the text, and the textarea's resize grabber is visible.
   Same grabber on the stopped panel's note. Fix hint: `resize: none` and
   hug the quote to the text (or drop the ::after). Files:
   src/ui/screens/SessionView.svelte (`.note`), src/ui/fly/FlyStoppedPanel.svelte.
6. **Low — CourseForm shows "A name is required." on a pristine form**
   before any input (mockup has no validation state). Show only after the
   field was touched/dirtied. File: src/ui/screens/CourseForm.svelte.
7. **Low — test-mode ARM not bottom-pinned** (mockup `margin-top:auto`);
   dead space below the button. File: src/ui/fly/FlyTestPanel.svelte.
8. **Low — armed clock format** is tenths without leading zero ("0.1") vs
   the mockup's "08.42" hundredths. Changing it touches the clock regex in
   fly.browser.test.ts — flagging for a deliberate decision, not silently.
   File: src/ui/fly/fly-format.ts (`formatRunningClock`).

Not flagged: headless-only artifacts (wake-lock failure line instead of the
Awake chip), data-dependent gaps (em-dash records), and every deviation the
wave notes above record as deliberate (status column, legend line, Edit
action, ISO header date, session-note display==edit, etc.).

## Visual polish fixes

All eight visual-review findings applied; confirmed by a throwaway browser
spec (390×844, quiet-scene camera + seeded 8-lap session, deleted after the
pass — after-shots in the session scratchpad `after/`). Full gates green:
typecheck, lint, unit (844), test:browser (90), build.

1. Best-3 bracket — `.table tr.b3band.first td` box-shadow scoped to
   `td:first-child` (App.svelte). The band's first row now shows ONE
   full-height amber tick; the short amber `.bar-i` on the best row is the
   separate mockup best-lap marker, not a regression.
2. Meter palette — canvas renderers re-tokened to the cyan sensor palette
   (canvas can't read custom properties, so hex mirrors of the tokens):
   panel ground `#131922`, trigger `#ffb84d`, HUD `#eaeef4`. drawStripBars
   grew an optional `hotThreshold` (0–1 of per-strip capacity): with it
   (fly/lab via drawNormalizedStripBars, which passes the trigger level)
   bars at/above the trigger draw hot `#33decf` and the rest dim
   `rgba(24,95,90,.5)` — the mockup `.bar`/`.bar.hot` two-tone; without it
   (diag panels, no trigger concept) uniform `rgba(51,222,207,.8)`. The
   replay timeline line is `#33decf` on the same ground. Diag/lab drawer
   chrome (`#16233c` selects/buttons) untouched — developer-tool UI, not the
   meter.
3. Armed full-height — FlyArmedPanel wrapped in a `.armed-screen` flex
   column (`min-height: calc(100dvh - 3rem)`, the CourseForm pin pattern):
   badge row top, clock + statgrid centered in an `.armed-mid` flex:1
   wrapper, Discard/STOP at the viewport bottom. FlyFlow trims `main.fly`
   bottom padding to 1.5rem (the global 4rem reserve is FAB clearance; fly
   has no FAB) — hence 3rem, not 5.5rem, in the calcs.
4. Setup compression — dead margins tightened (camrow/preview/hints/
   course-line/sens/speech-toggle/actions, camera buttons 10px pad) plus the
   main.fly bottom-padding trim: preview, meter, sensitivity, suggest, note,
   speech toggle AND Test mode now fit 390×844 with only ARM below the fold
   (was ~340px overflow). The preview's video geometry was left alone — ROI
   drag maps percentages onto the frame.
5. Note textareas — `resize: none` on both (SessionView, FlyStoppedPanel);
   SessionView's CSS quote glyphs dropped entirely (the note is an
   always-editable textarea, so flanking ::before/::after glyphs detach from
   the text — the `.empty` toggle went with them).
6. CourseForm validation — "A name is required." now gated on a
   `nameTouched` flag (set on first input or a submit attempt); pristine
   forms show nothing. The existing empty-name browser test dispatches
   `input`, so it pins the touched path unchanged.
7. Test-mode ARM — panel wrapped in the same full-height flex column;
   `.arm-big` is `margin-top: auto` (mockup 05), helper text keeps a 1rem
   floor above it.
8. Armed clock (DECIDED: hundredths) — formatRunningClock now renders
   `ss.hh` with two-digit zero-padded seconds ("08.42", mockup 06) and
   `m:ss.hh` past a minute; still truncating (a lap is not over until it
   is). Unit expectations rewritten; fly.browser.test.ts's pinned regex is
   `/^(?:(\d+):)?(\d{2})\.(\d{2})$/` (hundredths divisor). Lap durations
   elsewhere already showed 2dp — unchanged. No spec pins the clock
   precision (product.md's "tenths" is speech, untouched).
