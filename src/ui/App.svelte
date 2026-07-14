<script lang="ts">
  import type { CameraMediaDevicesLike } from '../core/camera/camera-service'
  import { checkCapabilities, type CapabilityReport } from '../core/capabilities/capabilities'
  import { routeFromHash, shouldShowUnsupportedScreen } from '../core/routing/route'
  import type { ResumeOutcome } from '../core/storage/storage'
  import { createStorageContext, type StorageContextOptions } from './data/storage-context.svelte'
  import type { FlySession } from './fly/fly-session'
  import { initPwaInstall } from './pwa-install.svelte'
  import CourseForm from './screens/CourseForm.svelte'
  import CourseView from './screens/CourseView.svelte'
  import DeleteCourse from './screens/DeleteCourse.svelte'
  import DeleteSession from './screens/DeleteSession.svelte'
  import Home from './screens/Home.svelte'
  import Diag from './screens/Diag.svelte'
  import Fly from './screens/Fly.svelte'
  import Lab from './screens/Lab.svelte'
  import SessionView from './screens/SessionView.svelte'
  import Unsupported from './screens/Unsupported.svelte'
  import UpdateBanner from './UpdateBanner.svelte'

  // mediaDevices/onsession are the browser E2E's fly-route seams (the same
  // ones Fly.svelte already exposes for its own tests); the real page passes
  // neither.
  let {
    check = checkCapabilities,
    createStorage,
    mediaDevices,
    onsession,
  }: {
    check?: () => Promise<CapabilityReport>
    createStorage?: StorageContextOptions['createStorage']
    mediaDevices?: CameraMediaDevicesLike
    onsession?: (session: FlySession) => void
  } = $props()

  // beforeinstallprompt fires once, early — register at startup, declared
  // here rather than left to whichever screen happens to import the module.
  initPwaInstall()

  let route = $state(routeFromHash(location.hash))
  let report = $state<CapabilityReport | null>(null)

  // One context per App mount, passed to the storage-backed screens as a prop
  // (the diag/fly session precedent). The seam is deliberately not reactive.
  // svelte-ignore state_referenced_locally
  const context = createStorageContext(createStorage ? { createStorage } : {})
  $effect(() => () => context.destroy())

  // svelte-ignore state_referenced_locally
  void check().then((result) => {
    report = result
  })

  // Resume notices (plan 09 items 9+10). They live here, not on Home: the app
  // restores the last hash route, so a relaunch after a crashed delete may land
  // anywhere.
  function resumeNotice(outcome: ResumeOutcome): string {
    if (outcome.kind === 'completed') {
      return `Finished deleting "${outcome.courseName}" — an earlier deletion was interrupted.`
    }
    return `An interrupted deletion of "${outcome.courseName}" was abandoned — you have flown on it since.`
  }
</script>

<svelte:window onhashchange={() => (route = routeFromHash(location.hash))} />

{#each context.quarantineNotices as notice (notice.id)}
  <div class="appnotice notice-warning" role="alert">
    <span>
      A stored file was corrupt and set aside{notice.quarantinedTo
        ? ` as ${notice.quarantinedTo}`
        : ''}: {notice.fileName}
    </span>
    <button onclick={() => context.dismissQuarantineNotice(notice.id)}>Dismiss</button>
  </div>
{/each}

{#each context.deletionNotices as notice (notice.id)}
  <div class="appnotice notice-warning" role="alert">
    <span>{resumeNotice(notice.outcome)}</span>
    <button onclick={() => context.dismissDeletionNotice(notice.id)}>Dismiss</button>
  </div>
{/each}

{#if report !== null && shouldShowUnsupportedScreen(report.ok, route)}
  <Unsupported {report} />
{:else if route.id === 'diag'}
  <Diag />
{:else if route.id === 'lab'}
  <Lab />
{:else if report === null}
  <p class="checking">Checking browser capabilities…</p>
{:else if route.id === 'fly'}
  <!-- Keyed: Fly resolves its course and prefill once per mount. -->
  {#key route.courseId}
    <Fly {context} courseId={route.courseId} {mediaDevices} {onsession} />
  {/key}
{:else if route.id === 'session'}
  {#key route.sessionId}
    <SessionView {context} sessionId={route.sessionId} />
  {/key}
{:else if route.id === 'new-course'}
  <CourseForm {context} />
{:else if route.id === 'edit-course'}
  <!-- Keyed: CourseForm seeds its fields once per mount, so a direct
       edit-A → edit-B navigation must remount, not reuse. -->
  {#key route.courseId}
    <CourseForm {context} courseId={route.courseId} />
  {/key}
{:else if route.id === 'course'}
  <!-- Keyed: CourseView loads its session bodies once per mount, so a direct
       course-A → course-B hash edit must remount, not reuse. -->
  {#key route.courseId}
    <CourseView {context} courseId={route.courseId} />
  {/key}
{:else if route.id === 'delete-course'}
  <!-- Keyed: the confirm screens count their blast radius once per mount. -->
  {#key route.courseId}
    <DeleteCourse {context} courseId={route.courseId} />
  {/key}
{:else if route.id === 'delete-session'}
  {#key route.sessionId}
    <DeleteSession {context} sessionId={route.sessionId} />
  {/key}
{:else}
  <Home {context} />
{/if}

<UpdateBanner />

<footer>build {__BUILD_ID__}</footer>

<style>
  /* Design tokens + shared classes from docs/mockups/ui-mockups.html (the
     phone-internal palette; the mockup's gallery-shell tokens don't apply). */
  :global {
    :root {
      --c-ground: #0a0e13;
      --c-panel: #131922;
      --c-panel2: #1b2431;
      --c-line: #27313f;
      --c-ink: #eaeef4;
      --c-dim: #808b99;
      --c-dim2: #59636f;
      --c-signal: #33decf; /* live sensor data: ROI, motion energy, armed */
      --c-signal-dim: #185f5a;
      --c-record: #ffb84d; /* records / bests */
      --c-record-dim: #6f5227;
      --c-danger: #ff5265;

      --font-mono:
        ui-monospace, 'SF Mono', SFMono-Regular, 'Cascadia Mono', 'Segoe UI Mono', Menlo, Consolas,
        'Liberation Mono', monospace;
      --font-sans:
        system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    }

    *,
    *::before,
    *::after {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      background: var(--c-ground);
      color: var(--c-ink);
      font-family: var(--font-sans);
      -webkit-font-smoothing: antialiased;
    }

    /* Phone-first: 40rem is every screen's default width. Desktop breakpoint
       is 48rem (≈768px); custom properties cannot parametrize media queries,
       so the review screens (Home, CourseView, SessionView) each repeat that
       literal in their own min-width query to widen themselves. The fly flow
       stays phone-first on purpose — it is a phone-beside-the-gate flow. */
    main {
      max-width: 40rem;
      margin: 0 auto;
      padding: 1.5rem 1rem 4rem;
    }

    a {
      color: var(--c-signal);
    }

    :focus-visible {
      outline: 2px solid var(--c-signal);
      outline-offset: 3px;
    }

    /* Shared notice boxes: every screen's storage-error / warning message uses
       these (screens add layout — margins, flex — locally when needed). */
    .notice-error {
      padding: 0.5rem 0.7rem;
      border-radius: 0.375rem;
      background: rgba(255, 82, 101, 0.08);
      border: 1px solid rgba(255, 82, 101, 0.4);
      color: var(--c-danger);
      font-size: 0.9rem;
      overflow-wrap: anywhere;
    }

    .notice-warning {
      padding: 0.5rem 0.7rem;
      border-radius: 0.375rem;
      background: rgba(255, 184, 77, 0.07);
      border: 1px solid var(--c-record-dim);
      color: var(--c-record);
      font-size: 0.9rem;
      overflow-wrap: anywhere;
    }

    /* ---- mockup vocabulary: typography ---- */
    .mono {
      font-family: var(--font-mono);
      font-variant-numeric: tabular-nums;
    }

    .label {
      font-family: var(--font-mono);
      font-size: 0.64rem;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: var(--c-dim2);
    }

    .hint {
      font-size: 0.76rem;
      color: var(--c-dim);
    }

    .caret {
      color: var(--c-signal);
    }

    /* ---- icons (stroke SVGs passed as snippets) ---- */
    .ic {
      display: block;
      width: 19px;
      height: 19px;
      stroke: currentColor;
      stroke-width: 1.7;
      fill: none;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    .ic-sm {
      display: block;
      width: 15px;
      height: 15px;
      stroke: currentColor;
      stroke-width: 1.8;
      fill: none;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    /* ---- cards & layout ---- */
    .card {
      background: var(--c-panel);
      border: 1px solid var(--c-line);
      border-radius: 16px;
      padding: 14px;
    }

    .stack {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .list {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    /* ---- buttons ---- */
    .btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 9px;
      width: 100%;
      border-radius: 14px;
      padding: 15px;
      font-family: var(--font-sans);
      font-size: 1rem;
      font-weight: 600;
      border: 1px solid transparent;
      letter-spacing: 0.01em;
      cursor: pointer;
    }

    .btn:disabled {
      opacity: 0.45;
      cursor: default;
    }

    .btn-primary {
      background: var(--c-signal);
      color: #04120f;
    }

    .btn-warm {
      background: var(--c-record);
      color: #1a1204;
    }

    .btn-ghost {
      background: var(--c-panel);
      border-color: var(--c-line);
      color: var(--c-ink);
    }

    /* Filled danger is RESERVED (plan 09 item 11): the confirm button on the
       delete screens, and the armed STOP button pilots slam from muscle memory.
       Nothing else may wear it. */
    .btn-danger {
      background: var(--c-danger);
      color: #1b0407;
    }

    /* The INITIATING danger controls (the edit form's delete, the session view's)
       — loud enough to read as destruction, quiet enough that it is not the thing
       your thumb lands on. Reuses .notice-error's rgba pair above. */
    .btn-danger-ghost {
      background: rgba(255, 82, 101, 0.08);
      border-color: rgba(255, 82, 101, 0.4);
      color: var(--c-danger);
    }

    .btn-stop {
      padding: 26px;
      font-size: 1.5rem;
      font-weight: 700;
      letter-spacing: 0.06em;
      border-radius: 18px;
    }

    /* ---- form fields ---- */
    .field {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .field .val {
      background: var(--c-ground);
      border: 1px solid var(--c-line);
      border-radius: 12px;
      padding: 14px;
      font-size: 1rem;
      color: var(--c-ink);
    }

    .field .val.mono {
      font-family: var(--font-mono);
    }

    .seg {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }

    .seg .opt {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      padding: 14px 8px;
      border-radius: 12px;
      border: 1px solid var(--c-line);
      background: var(--c-ground);
      color: var(--c-dim);
      font-family: var(--font-sans);
      font-size: 1rem;
      cursor: pointer;
    }

    .seg .opt.sel {
      border-color: var(--c-signal);
      background: rgba(51, 222, 207, 0.08);
      color: var(--c-ink);
    }

    .seg .opt .arw {
      font-family: var(--font-mono);
      font-size: 1.2rem;
      letter-spacing: 0.1em;
      color: var(--c-signal);
    }

    .seg .opt:not(.sel) .arw {
      color: var(--c-dim2);
    }

    .seg .opt small {
      font-size: 0.74rem;
    }

    .stepper {
      display: flex;
      align-items: center;
      gap: 12px;
      background: var(--c-ground);
      border: 1px solid var(--c-line);
      border-radius: 12px;
      padding: 8px;
    }

    .stepper button {
      width: 40px;
      height: 40px;
      border-radius: 9px;
      border: 1px solid var(--c-line);
      background: var(--c-panel);
      color: var(--c-ink);
      font-size: 1.3rem;
      line-height: 1;
      cursor: pointer;
    }

    .stepper button:disabled {
      opacity: 0.45;
      cursor: default;
    }

    .stepper .n {
      flex: 1;
      text-align: center;
      font-family: var(--font-mono);
      font-variant-numeric: tabular-nums;
      font-size: 1.5rem;
      font-weight: 600;
    }

    .stepper .n small {
      font-size: 0.8rem;
      color: var(--c-dim);
      font-weight: 400;
    }

    /* ---- sliders ----
       .slider/.fill/.knob is the mockup's custom slider for screens that build
       one; .slider-native styles a real input[type=range] to match (Chromium
       can't paint the filled-track portion without JS, so there the track is
       uniform — Firefox gets the fill via ::-moz-range-progress). */
    .slider {
      position: relative;
      height: 8px;
      border-radius: 999px;
      background: var(--c-line);
      margin: 14px 8px;
    }

    .slider .fill {
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      border-radius: 999px;
      background: var(--c-signal);
    }

    .slider .knob {
      position: absolute;
      top: 50%;
      width: 22px;
      height: 22px;
      border-radius: 50%;
      background: var(--c-signal);
      transform: translate(-50%, -50%);
      box-shadow: 0 0 0 5px rgba(51, 222, 207, 0.16);
    }

    input[type='range'].slider-native {
      -webkit-appearance: none;
      appearance: none;
      width: 100%;
      height: 8px;
      border-radius: 999px;
      background: var(--c-line);
      accent-color: var(--c-signal);
      margin: 14px 0;
    }

    input[type='range'].slider-native::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: 22px;
      height: 22px;
      border: none;
      border-radius: 50%;
      background: var(--c-signal);
      box-shadow: 0 0 0 5px rgba(51, 222, 207, 0.16);
      cursor: pointer;
    }

    input[type='range'].slider-native::-moz-range-thumb {
      width: 22px;
      height: 22px;
      border: none;
      border-radius: 50%;
      background: var(--c-signal);
      box-shadow: 0 0 0 5px rgba(51, 222, 207, 0.16);
      cursor: pointer;
    }

    input[type='range'].slider-native::-moz-range-progress {
      height: 8px;
      border-radius: 999px;
      background: var(--c-signal);
    }

    /* ---- review lap table (scoped under .table so the diag/lab tables and
       the legacy LapTable markup keep their own styling) ---- */
    .table {
      width: 100%;
      border-collapse: collapse;
      font-family: var(--font-mono);
      font-variant-numeric: tabular-nums;
    }

    .table th {
      font-size: 0.58rem;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--c-dim2);
      font-weight: 500;
      text-align: right;
      padding: 4px 8px 8px;
    }

    .table th:first-child {
      text-align: left;
    }

    .table td {
      font-size: 0.92rem;
      padding: 8px;
      text-align: right;
      border-top: 1px solid var(--c-line);
      color: var(--c-ink);
    }

    .table td:first-child {
      text-align: left;
      color: var(--c-dim);
    }

    .table td .tod {
      color: var(--c-dim);
      font-size: 0.82rem;
    }

    .table tr.best td,
    .table tr.best td:first-child {
      color: var(--c-record);
    }

    .lap-num {
      display: inline-flex;
      align-items: center;
      gap: 7px;
    }

    .lap-num .bar-i {
      width: 3px;
      height: 14px;
      border-radius: 2px;
      background: transparent;
    }

    .table tr.best .bar-i {
      background: var(--c-record);
    }

    .table tr.b3band td {
      background: rgba(255, 184, 77, 0.06);
    }

    .table tr.b3band.first td:first-child {
      box-shadow: inset 3px 0 0 var(--c-record);
    }

    .table tr.discarded td,
    .table tr.discarded td:first-child {
      color: var(--c-dim2);
      text-decoration: line-through;
      text-decoration-color: var(--c-dim2);
    }

    .disc-tag {
      font-family: var(--font-mono);
      font-size: 0.54rem;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--c-danger);
      text-decoration: none;
      display: inline-block;
      margin-left: 6px;
      vertical-align: middle;
    }

    .b3label {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-family: var(--font-mono);
      font-size: 0.6rem;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--c-record);
      padding: 8px 8px 2px;
    }

    /* ---- test-mode screen-edge flash (viewport edge — the mockup's phone
       bezel becomes the real screen here) ---- */
    .flashborder {
      position: fixed;
      inset: 6px;
      border-radius: 30px;
      border: 2px solid var(--c-signal);
      pointer-events: none;
      z-index: 50;
      opacity: 0.55;
    }
  }

  .checking {
    padding: 1.5rem 1rem;
    text-align: center;
    opacity: 0.7;
  }

  /* App-level dismissible notices: quarantine (a corrupt file was set aside)
     and deletion resume (a crashed cascade was finished or abandoned). */
  .appnotice {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    max-width: 40rem;
    margin: 0.5rem auto 0;
  }

  .appnotice button {
    flex-shrink: 0;
    background: transparent;
    color: inherit;
    border: 1px solid var(--c-record-dim);
    border-radius: 0.375rem;
    padding: 0.25rem 0.6rem;
    cursor: pointer;
  }

  footer {
    position: fixed;
    bottom: 0.25rem;
    right: 0.5rem;
    font-family: var(--font-mono);
    font-size: 0.7rem;
    opacity: 0.4;
  }
</style>
