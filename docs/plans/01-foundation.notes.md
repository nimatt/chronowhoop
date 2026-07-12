# Staging notes — implement docs/plans/01-foundation.md

Working notes from the /implement-plan run of Phase 1 (Foundation), 2026-07-12.
Assumptions, open questions, and disputed review findings land here for later
promotion into ADRs/specs or deletion.

## Pre-implementation

Plan: `docs/plans/01-foundation.md` (roadmap: `docs/plans/00-roadmap.md`).
Repo state at start: greenfield — docs only, clean working tree at `006ee91`.

### Assumptions

- **Package manager: bun** (user correction, 2026-07-12; bun 1.3.14). Scripts run as `bun run <script>`; the plan's `npm run deploy` reads as `bun run deploy`.
- **Scaffold lives at repo root** (`package.json`, `src/`, `vite.config.ts` at top level), not in a subdirectory.
- **Routing: hand-rolled hash router** as the plan recommends; routes `#/` (home), `#/diag`, `#/lab`; capability-fail is a gate state, not a route.
- **Service worker: vite-plugin-pwa** with `registerType: 'prompt'` (explicit update prompt), `injectRegister` manual wiring, disabled in dev — rather than hand-rolled. It generates the full-bundle precache manifest for free and is the maintained path.
- **Build id = short git commit hash** injected at build time via Vite `define` (fallback `dev` when not in a git context).
- **Browser-context tests: Vitest browser mode with the Playwright provider** (Chromium gating, WebKit informational) instead of a separate Playwright test harness — one test runner for everything in Phase 1. Playwright proper can still arrive in Phase 7 for E2E.
- **WebGPU CI job** = Vitest browser mode, headless Chromium launched with SwiftShader flags (`--enable-unsafe-swiftshader`, `--enable-features=Vulkan` as needed).
- **Custom domain** attached via `wrangler.jsonc` `routes: [{ pattern: "chronowhoop.com", custom_domain: true }]`, assuming the chronowhoop.com zone exists in the authenticated Cloudflare account.
- **ESLint flat config** with `typescript-eslint` + `eslint-plugin-svelte`; seams enforced via `no-restricted-imports` (core→svelte) and `no-restricted-syntax`/`no-restricted-globals` (OPFS APIs outside `src/core/storage/**` and test files).

### Open questions (resolved 2026-07-12 unless noted)

- **No git remote exists.** Resolved: do not push; local commits on main. CI workflows are authored now; CI-green verification is deferred until the user pushes to GitHub and adds `CLOUDFLARE_API_TOKEN` (+ account id) secrets.
- **chronowhoop.com zone** — confirmed already in the Cloudflare account; local `bun run deploy` is expected to work.
- **Device procurement (work item 11)** — still open; physical-world item only the user can confirm.

## Phase logs

(appended by implementer subagents below)

## Phase 1 — Scaffold + seams

- **Assumption:** TypeScript pinned to `~6.0.2` (not latest 7.0.2). `bun add -d typescript` pulled TS 7.0.2, which triggered incorrect-peer-dependency warnings from svelte-check and typescript-eslint; the current `bun create vite` svelte-ts template also pins `~6.0.2`. If TS 7 support lands in those tools, bumping is a one-line change.
- **Assumption:** Test layout is colocated — `*.test.ts` next to the module under test (e.g. `src/core/storage/opfs-probe.test.ts`). Vitest runs node environment with `include: ['src/**/*.test.ts']` in `vite.config.ts` (config via `vitest/config`, no separate vitest.config file). Would change if a later phase wants split unit/browser-mode configs — Vitest workspaces can absorb that.
- **Assumption:** OPFS seam implemented with `no-restricted-syntax` only, not `no-restricted-globals`. `no-restricted-globals` was not useful: the touched global is `navigator`, which legit code uses for camera/speech probes. Selectors match `MemberExpression`s by property name, erroring everywhere except `src/core/storage/**` and the test globs via config-level `files`/`ignores`. Trade-off: any unrelated object with a same-named method false-positives outside the allowlist — accept and revisit if it bites. Method set and matched forms were widened during the seam review — see "Seam review hardening" below (supersedes the original two-method / narrower-selector notes).
- **Assumption:** Core-is-framework-free rule scoped to `files: ['src/core/**']` with `no-restricted-imports` patterns `['svelte', 'svelte/**', '*.svelte', '**/*.svelte']` (`svelte/**` replaced `svelte/*` so nested subpaths like `svelte/legacy/*` are caught). Only import syntax is caught; a `require()` or dynamic `import()` of svelte would slip through — irrelevant in this ESM + lint-per-commit setup.

### Seam review hardening (2026-07-12)

Resolution of a cluster of Phase-1 review findings on `eslint.config.js` (OPFS/core seams, globals scoping). All changes are in `eslint.config.js` plus a new permanent self-test `src/core/lint-seams.test.ts` (runs in the `unit` Vitest project). `bun run check` green after.

- **One coherent OPFS selector strategy.** The seam now guards **all static syntactic forms** — dot access (`x.getDirectory`), computed-string access (`x['getDirectory']`), and destructuring (`const { getDirectory } = x`) — of the full OPFS **method table**: `getDirectory`, `getFileHandle`, `getDirectoryHandle`, `removeEntry`, `createWritable`, `createSyncAccessHandle`. Selectors are generated from that one table via `flatMap`, so widening scope is a one-line edit and the config stays reviewable.
- **What it defends against:** accidental direct OPFS use, and a storage-module handle *leaking* into UI/core code where its methods (incl. the production `createSyncAccessHandle`, `getFileHandle`, `removeEntry`) get called directly. Previously only `getDirectory`/`createWritable` were guarded, so a leaked directory handle escaped the seam.
- **Deliberately NOT caught (accepted residual gap, by design — the seam is a guardrail, not an adversarial boundary):** dynamic property access via a variable key (`x[name]()`), reflective access (`Reflect.get`), and re-aliasing / `.call` / `.apply`. Closing these is impossible for a static lint rule and they require intent to evade. The destructuring gap the reviewer demonstrated (`const { getDirectory } = nav.storage`) *is* now closed, as it was a cheap, single-selector static form. The self-test asserts the dynamic-access gap stays uncaught so nobody "fixes" it as a bug.
- **Kept computed-string selectors** (a reviewer suggested dropping them as belt-and-suspenders). Dropping would weaken current coverage; generating them from the method table keeps the config compact, so the simplicity concern is addressed without losing the form.
- **Permanent self-test** (`src/core/lint-seams.test.ts`): runs `ESLint` programmatically via `lintText({ filePath })` over inline snippets and asserts — core-importing-svelte errors (incl. a nested `svelte/legacy/*` subpath), UI-file OPFS errors for every method × every kept form, the same OPFS code inside `src/core/storage/**` passes, OPFS in a unit / browser-mode test-file path passes, and the dynamic-access gap stays uncaught. No `package.json`/`vitest.config.ts` change was needed: the file matches the `unit` project's `src/**/*.test.ts` include and imports `eslint` only in that node project (browser projects include only `*.browser.test.ts`/`*.webgpu.test.ts`, so nothing leaks). ESLint auto-discovers the flat config from cwd (Vitest root).
- **Globals scoping.** `globals.browser` (+ `__BUILD_ID__`) is now scoped to `files: ['src/**']` instead of applied unscoped; a new block gives `globals.node` to config files and scripts (`*.config.ts`, `*.config.js`, `scripts/**`, `eslint.config.js`). Previously node config files got browser globals and no node globals (harmless today only because `no-undef` is off for TS, but wrong).
- **Test-file OPFS exemption is project-wide** (`**/*.test.ts` etc.), so OPFS calls in *any* test file — not just storage tests — are unflagged. Accepted: tests legitimately exercise real OPFS and the exemption surface is explicitly listed/reviewed in the config comment; the storage seam is a production-code boundary, not a test-code one.

## Disputed findings

- **Finding (test-rigor, nit):** ci.yml's two gating jobs share an identical Playwright cache key (harmless save race, no restore-keys); reviewer said leave-as-is is acceptable.
- **Why rejected:** Out of the allowed change scope for this task (ci.yml is not to be touched here), and the reviewer themselves rated it acceptable to leave — a benign concurrent-save race that resolves to the same artifact. No correctness or security impact. Left for a future CI-focused pass if ever worth a `restore-keys` tidy.
- **Assumption:** `typecheck` script is `tsc -b && svelte-check --tsconfig ./tsconfig.app.json` rather than literal `tsc --noEmit`: the scaffold uses project references (`tsconfig.app.json` + `tsconfig.node.json`), both with `noEmit: true`, so `tsc -b` is the equivalent that checks both projects.
- **Assumption:** `"strict": true` added explicitly to `tsconfig.app.json` even though the `@tsconfig/svelte` base already enables it — the plan asks for it explicitly and it survives base-config changes.
- **Assumption:** Kept the generated template's demo content out entirely (no `app.css`, no `public/` assets, no Counter component); `src/ui/App.svelte` is a two-line placeholder. No `src/core/storage/index.ts` barrel yet — first real consumer (Phase 1 item 4 capability module) decides the module's public surface.
- **Open question:** eslint-plugin-svelte's recommended config also enabled `svelte/no-svelte-internal` etc. globally — fine now, but nobody has reviewed the full recommended rule set against project taste. Resolve when the first real component work starts.

## Phase 2 — App shell

- **Assumption:** Capability probe results are typed structurally (`GpuLike`, `MediaDevicesLike`) instead of adding `@webgpu/types`, matching the `opfs-probe.ts` pattern. Phase 3's real pipeline code will want `@webgpu/types`; the probe interfaces can then be narrowed to the real types.
- **Assumption:** The WebGPU probe requests a device with **default limits** and destroys it immediately. Phase 3 revisits requested limits once the detection pipeline's buffer/workgroup needs are known (comment left in `capabilities.ts`).
- **Assumption:** Router split: pure hash→route mapping and gate-exemption decision live in `src/core/routing/route.ts` (plain TS, unit-tested — including `shouldShowUnsupportedScreen`); the reactive side is just a `$state` + `<svelte:window onhashchange>` in `App.svelte`. No separate ui router module — at three routes it would be indirection with no benefit. Revisit if routes gain params or programmatic navigation.
- **Assumption:** Gate semantics: while probes are still running, `/diag` and `/lab` render immediately; the home route shows a brief "Checking browser capabilities…" state rather than flashing Home and swapping to Unsupported. Capability check runs once per page load in the shell; `/diag` runs its own fresh check on entry (plus a manual "Re-run probes" button).
- **Assumption:** The unsupported screen's browser list is prose from ADR 0002/0006: Android Chrome (primary), desktop Chromium, iOS Safari 26+ labeled best-effort. No user-agent sniffing or version detection — the probe results are the ground truth shown.
- **Assumption:** `speechSynthesis` probe is presence-only. Voices may legitimately be empty at probe time (Chrome populates `getVoices()` asynchronously); actual speech quality is a Phase 5 concern.
- **Assumption:** Placeholder icons are generated by `scripts/generate-icons.ts` (hand-rolled PNG encoder, no deps; `bun run icons`) — solid `#0b1220` background with blocky "CW" in `#7ea6ff`; 192, 512, and a maskable 512 with a wider safe zone. Committed as files in `public/icons/`; real artwork is an explicit later item.
- **Assumption:** SW precache glob is `**/*.{js,css,html,svg,ico}`; icons and the web manifest are added to the precache by vite-plugin-pwa itself (from the manifest icon list), avoiding duplicate entries. Full bundle is precached (8 entries currently).
- **Assumption:** Update flow uses `registerSW` from `virtual:pwa-register` (framework-agnostic API) inside `UpdateBanner.svelte` rather than a Svelte-specific wrapper; `onNeedRefresh` flips a `$state` flag, "Update now" calls `updateSW(true)` (skipWaiting + reload). Dev builds get the no-op stub (`devOptions.enabled: false`).
- **Assumption:** Build id (`__BUILD_ID__` via Vite `define`, `git rev-parse --short HEAD`, fallback `dev`) is baked at build time and shown in the fixed footer and on `/diag`. Dev server also shows the current HEAD hash, not `dev` — the fallback only triggers outside a git checkout (e.g. a tarball CI build). Acceptable; a `-dirty` suffix was skipped as noise.
- **Assumption:** Added `__BUILD_ID__: 'readonly'` to ESLint globals (svelte-file linting flags it as no-undef; TS files get it from `src/vite-env.d.ts`). `scripts/` added to `tsconfig.node.json` include so the icon script is typechecked by `tsc -b`.
- **Open question:** iOS `theme_color`/standalone styling and install-prompt behavior are unverified until an iOS device is available (ADR 0006 — best-effort, skip without ceremony).
- **Open question:** Whether the "Checking browser capabilities…" flash on slow devices needs a minimum-display/skeleton treatment — decide when the real product UI lands (Phase 6).

## Phase 4 — Docs

Work items 6 (documentation half — routing decision) and 10 (test taxonomy).
Created `docs/decisions/0007-hash-routing.md` and `docs/testing.md`.

- **Assumption:** ADR 0007's "roughly three visible routes" counts home plus the
  later product screens generically; only `#/`, `#/diag`, `#/lab` exist today. The ADR
  documents the already-implemented `src/core/routing/route.ts` split verbatim rather
  than proposing anything new.
- **Assumption:** `docs/testing.md` defers all concrete script names to `package.json`
  (per task instruction — CI scripts are owned by concurrent work). It describes each
  category and its gating status without hardcoding command strings; only the WebGPU
  SwiftShader flag `--enable-unsafe-swiftshader` is named, quoting the plan.
- **Assumption:** Phase attributions in `testing.md` follow the roadmap: browser-contract
  spike in Phase 1 / contract suite Phase 6; GPU-golden rig Phase 1 / real tests Phase 3;
  on-device self-test Phase 3; video-E2E full loop Phase 5 with Phase 3 tooling and Phase 4
  detector assertions; manual checklist Phase 2 device-matrix / Phase 7 field acceptance.
- **Open question:** `testing.md` names the fixture tolerances (±1 frame detection, ±2 frame
  E2E) from the roadmap; the authoritative numbers will live in `docs/specs/detection.md`
  once Phase 3/4 write them. If they change, the taxonomy's parenthetical should point at the
  spec rather than restate the figures.
- **Out of scope (noticed):** `docs/specs/product.md` and `README.md` show as modified in the
  working tree (other agents' concurrent work); left untouched. No existing ADR, spec, or plan
  was edited.

## Phase 3 — Deploy + CI rigs

Work items 3 (deploy pipeline) and 9 (CI verification spikes). Implemented 2026-07-12.

### Results recorded (plan item 9: "run all three, record results")

- **Node/Vitest unit rig:** unchanged — 32 tests, 3 files, green. Now runs as the
  `unit` Vitest project (`bun run test` = `vitest run --project unit`), so `check`
  stays fast and browser-free.
- **Browser-context OPFS rig (Chromium, gating):** GREEN locally. `bun run test:browser`
  writes a file through real `navigator.storage.getDirectory()` → `createWritable` →
  reads it back and asserts content, plus runs `probeOpfs()` and asserts `{ ok: true }`.
  Playwright's bundled Chromium, true headless.
- **Browser-context OPFS rig (WebKit, informational):** could NOT run on this machine —
  Playwright WebKit needs host libs that require sudo to install (`libevent-2.1-7t64`,
  `libavif16`, `libmanette-0.2-0`, `libwoff1`). Per ADR 0006 this is best-effort, so it
  is wired as a `continue-on-error: true` CI job (with `playwright install --with-deps
  webkit`, which installs those libs on the runner) and left non-gating. Unverified until
  first CI run.
- **Headless Chromium WebGPU rig (gating):** GREEN locally in TRUE headless Playwright
  Chromium on the software (SwiftShader) backend. `bun run test:webgpu` requests
  adapter+device, dispatches a `@workgroup_size(64)` WGSL compute shader that doubles an
  8-element `f32` array, reads back via `copyBufferToBuffer` + `mapAsync`, and asserts
  exact values `[2,4,…,16]`.

### Exact WebGPU launch flags (the core deliverable)

Flags set in `vitest.config.ts` (`webgpu` project, via `playwright({ launchOptions: { args } })`):

```
--enable-unsafe-swiftshader
--enable-unsafe-webgpu
--enable-features=Vulkan
--use-vulkan=swiftshader
```

Empirically narrowed on this machine (Playwright Chromium, bun 1.3.14):

- `--enable-unsafe-swiftshader` **alone → FAILS** (`requestAdapter()` returns null). This
  flag only re-enables the SwiftShader *GL* fallback; it does not by itself yield a WebGPU
  adapter here.
- The **software WebGPU adapter comes from the Dawn Vulkan backend on SwiftShader's Vulkan
  ICD**: `--enable-unsafe-webgpu` + `--enable-features=Vulkan` + `--use-vulkan=swiftshader`
  is the minimal set that passed. Dropping any one of the three failed.
- `--enable-unsafe-swiftshader` is kept in the committed set as a documented, harmless CI
  guard (it is the flag Chromium release notes point CI at, and some Chromium versions gate
  the software adapter behind it). `--use-angle=swiftshader` was tried and is NOT needed
  (it only affects WebGL/ANGLE, not the Vulkan WebGPU path); dropped.

### Wrangler config validation

- `wrangler.jsonc`: assets-only Worker (no `main`), `assets.directory: ./dist`,
  `not_found_handling: single-page-application`, `routes: [{ pattern: "chronowhoop.com",
  custom_domain: true }]`, `compatibility_date: 2026-07-12`.
- `bunx wrangler deploy --dry-run` PASSED: read 12 files from `./dist`, no bindings,
  "--dry-run: exiting now." No real deploy was executed (orchestrator runs `bun run deploy`
  separately with user-visible permissions).

### Assumptions

- **Vitest projects, not a separate Playwright harness.** Config moved out of
  `vite.config.ts` into a dedicated `vitest.config.ts` with four `projects`: `unit` (node),
  `browser` (chromium browser-mode, `*.browser.test.ts`), `browser-webkit` (webkit, same
  files), `webgpu` (chromium + SwiftShader flags, `*.webgpu.test.ts`). `vite.config.ts` lost
  its `test` block and now imports `defineConfig` from `vite` (app build only). Browser
  projects deliberately do NOT load the svelte/PWA plugins — the spikes are plain-TS core
  tests, and keeping the service worker out of the test server avoids interference.
- **Provider is the Vitest 4 factory API.** Vitest 4.1.10 replaced the `provider: 'playwright'`
  string with a factory: added `@vitest/browser-playwright` and use `playwright()` /
  `playwright({ launchOptions: { args } })`. Also added `@vitest/browser`.
- **Unit `include` overlaps browser globs**, so the `unit` project explicitly excludes
  `*.browser.test.ts` and `*.webgpu.test.ts` (both end in `.test.ts` and would otherwise be
  picked up by the node runner).
- **WebGPU/OPFS types in tests:** added `@webgpu/types` as a dev dep and to
  `tsconfig.app.json` `types` so `navigator.gpu`/`GPUBufferUsage` typecheck in the spike; DOM
  lib already covers `navigator.storage`. `vitest.config.ts` added to `tsconfig.node.json`
  include so `tsc -b` typechecks it.
- **ESLint OPFS allowlist:** `*.browser.test.ts` already matched the existing `**/*.test.ts`
  ignore, but `**/*.browser.test.ts` and `**/*.webgpu.test.ts` were added explicitly (with a
  comment) so the allowed surface stays reviewed rather than incidental.
- **`not_found_handling: single-page-application`** despite hash routing — the server only
  ever sees `/` for real navigations, so this is purely defensive (stray deep links / hard
  refreshes resolve to the app shell instead of a bare 404).
- **Deploy is a gated job inside `ci.yml`** (`needs: [check, browser-opfs-chromium, webgpu]`,
  `if: push to main`) rather than a separate `workflow_run` workflow — guarantees "after CI
  passes" ordering without cross-workflow plumbing. `bun run deploy` = `bun run build &&
  wrangler deploy`.

### Open questions

- **CI never executed (no git remote).** All three rigs are green LOCALLY and the workflow
  YAML parses, but nothing has run on a GitHub runner. First push verifies. Because Playwright
  pins its browser builds, CI Chromium == local Chromium, so the SwiftShader flags should
  hold; the residual risk is the runner's system Vulkan/SwiftShader libs, which
  `playwright install --with-deps chromium` is expected to cover. If the WebGPU job goes red
  on GitHub runners despite this, the plan's fallback decision (self-hosted GPU runner vs
  mandatory local pre-merge GPU suite) is owed to the user — flag it, do not silently drop the
  job.
- **WebKit rig is unverified** (see above) — first CI run with `--with-deps webkit` is the
  first real signal. Non-gating regardless.
- **Deploy secrets not set.** `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` must be added
  as repo Actions secrets before the deploy job can run; documented in `ci.yml` comments.
- **chronowhoop.com custom-domain attach** happens on the first real `wrangler deploy`; the
  dry-run cannot exercise it. If the zone isn't in the authenticated account the deploy (not
  the config) will error.

### Out of scope (noticed)

- No product/app-shell/capability code touched; only `vite.config.ts` (test block removed),
  `package.json` (scripts + dev deps), `eslint.config.js` (allowlist globs), the two
  tsconfigs, and new test/config/CI files. No git commit made. WebKit host-dep install and
  the real `wrangler deploy` intentionally not run.

## Review-fix log (UI shell, 2026-07-12)

Fixes applied from code-review findings against the Phase 1 UI shell.

- **Finding 1 (SW registration in presentational banner) — applied.** `registerSW` moved out
  of `UpdateBanner.svelte` into `src/ui/pwa.svelte.ts`, a runes module exposing `swUpdate`
  (`.available` getter + `.activate()`). The banner now just consumes the signal.
  `virtual:pwa-register` stays in the UI layer (vite-plugin-pwa), not `src/core`.
- **Finding 2 (Diag re-run race) — applied.** `runProbes()` in `src/ui/screens/Diag.svelte`
  now captures a monotonic `latestRun` id before the await and applies the result only if the
  run is still current, preventing an overlapping re-run's stale response from winning.
- **Finding 3 (gate wiring lacks component-level test) — applied (test written).** Initially
  logged as accepted coverage debt; the user reversed that ("not accepting coverage debt this
  early") and the component test was written instead. New `src/ui/app-gate.browser.test.ts`
  (Vitest browser mode, `browser`/`browser-webkit` glob) mounts the real `App.svelte` and
  verifies the gate wiring end-to-end. See the Phase 5 log below for the seam and config
  judgment calls this required.

No findings were rejected.

## Phase 5 — App-gate component test (2026-07-12)

Wrote `src/ui/app-gate.browser.test.ts` after the user rejected the Phase 1 coverage debt on
the capability gate. The test mounts the real `App.svelte` (svelte `mount`/`unmount`, no
`vitest-browser-svelte` needed) and asserts, via `location.hash` + real `hashchange`:
1. pending check → home shows "Checking browser capabilities…" while `#/diag` and `#/lab`
   render immediately (gate exemption);
2. failing report → Unsupported with per-capability results (`WebGPU`/`FAIL`) and the
   `#/diag` link; `#/diag` renders Diag (exempt); back to `#/` re-shows Unsupported
   (hashchange re-evaluation);
3. all-pass report → Home.

Judgment calls:

- **Injection seam:** added an optional `check` prop to `App.svelte` defaulting to the real
  `checkCapabilities` (`let { check = checkCapabilities } = $props()`). This is the thinnest
  seam that lets the test supply a pending / failing / all-pass report — the `browser` project
  has no WebGPU flags, so a real all-pass report is unreachable there. `App.svelte` is
  otherwise unchanged.
- **`untrack` on the initial call:** reading the new `check` prop once at instance top level
  tripped svelte's `state_referenced_locally` warning (a prop is reactive; the old
  module-imported `checkCapabilities` was not). The read is intentionally one-shot, so it is
  wrapped in `untrack(() => check())` to state that intent and keep `svelte-check` clean.
- **Browser projects now load the svelte plugin.** The Phase 3 assumption "browser projects
  deliberately do NOT load the svelte/PWA plugins" held only while the browser rigs were
  plain-TS core spikes. A component test must compile `.svelte`, so `vitest.config.ts` now
  gives both browser-mode projects (`browser`, `browser-webkit`) `svelte()` and the
  `__BUILD_ID__` define (App's footer needs it), factored into a `browserProject()` helper.
  The `unit` and `webgpu` projects stay plain-TS and unchanged.
- **`virtual:pwa-register` stub.** Mounting `App` pulls in `UpdateBanner` → `pwa.svelte.ts` →
  `virtual:pwa-register`, which only exists when VitePWA is loaded — and the browser projects
  still don't load VitePWA (no service worker in the test server, per Phase 3). A tiny inline
  Vite plugin (`stubPwaRegister` in `vitest.config.ts`) resolves the virtual id to a no-op
  `registerSW`, so `onNeedRefresh` never fires and the banner stays hidden. Cheaper and more
  contained than running the PWA plugin in tests.
- **State isolation:** `history.replaceState` clears the hash in `beforeEach`; each case mounts
  into a fresh container and unmounts in `afterEach`. The pending cases use a never-settling
  promise so `report` stays `null`.
- **Verified:** `bun run test:browser` green (6 tests: 2 pre-existing OPFS + 4 new gate);
  `bun run check` green. WebKit (`test:browser-webkit`) not run here — its host libs need sudo
  (Phase 3 note) — but it now has the same plugin/define setup so it is not left broken.

## Review-fix log (docs + tooling, 2026-07-12)

Fixes applied from code-review findings against the Phase 1 docs/tooling cluster
(`docs/testing.md`, `scripts/generate-icons.ts`, `package.json`).

- **Finding 1 (GPU-golden flag naming) — applied.** testing.md's GPU-golden "Where" line
  named `--enable-unsafe-swiftshader` as *the* software-WebGPU flag, but that flag alone
  returns a null adapter (see "Phase 3 → Exact WebGPU launch flags" above); the working set is
  the Vulkan-on-SwiftShader trio. Softened to "SwiftShader; the exact Chromium flags live in
  `vitest.config.ts`". Supersedes the earlier Phase 4 note that testing.md names that flag
  "quoting the plan".
- **Finding 2 (E2E tolerance stated as settled) — applied.** `±1 frame` is anchored in
  `docs/specs/product.md`; the `±2 frame E2E` number lived only in the roadmap yet testing.md
  presented both as a "fixture contract". Rephrased so ±1 is attributed to the spec and ±2 is a
  roadmap working target pending the authoritative definition in `docs/specs/detection.md`
  (Phase 3/4). Matches the Phase 4 open question recorded above.
- **Finding 3 (icon generator is one-shot dead code) — applied (deleted).** Removed
  `scripts/generate-icons.ts` (hand-rolled PNG encoder: CRC32 + deflate + glyph raster) and its
  `package.json` `icons` script. The three outputs in `public/icons/` (`icon-192`, `icon-512`,
  `icon-maskable-512`) are **committed artifacts** and stay; real artwork remains an explicit
  later item (Phase 2 assumption above). The generator had no ongoing role — not in
  `build`/`check`/`deploy`, run once, effectively dead after — so it was net surface (123 lines,
  plus it sat in the `tsc -b` path via `tsconfig.node.json`'s `scripts/**/*.ts` include). Git
  history preserves it if the placeholders ever need regenerating. That glob now matches nothing
  under `scripts/`, which is harmless: `vite.config.ts` + `vitest.config.ts` keep the project
  non-empty so `tsc -b` still resolves inputs (verified by `bun run check`).
- **Finding 4 (capabilities.ts deep-imports `probeOpfs`) — not coded; logged as follow-up.**
  Reviewer flagged the deep file-path import instead of a storage barrel/surface. This is the
  deliberate deferral already recorded ("first real consumer decides the module's public
  surface" — Phase 1 assumption) and `src/` is out of this cluster's scope. Logged under
  "Follow-ups" below rather than changed.

No findings were rejected.

## Follow-ups

- **Storage module public surface (Phase 6).** `src/core/capabilities.ts` imports `probeOpfs`
  via a deep file path rather than a storage-module barrel/surface. Fine as the minimal surface
  for a single consumer today. When the Phase 6 storage interface is introduced (the one seam
  per CLAUDE.md), it should define the module's public surface and repoint `capabilities.ts` at
  it.

## Disputed findings — capability/probe review (2026-07-12)

Review-cluster fixes applied to `capabilities.ts`/`opfs-probe.ts` and their tests
(Findings 2, 3, 4, 5, 8 applied; 1 applied as structural-only). Findings kept as-is:

- **Finding 6 (keep).** The hand-rolled `Opfs*Like` interface tower + fake in
  `opfs-probe.test.ts` duplicates DOM types for the node test. Kept: plan item 4 explicitly
  requires "probes injected so the module is unit-testable without real feature absence," and
  the fake is what exercises the three failure branches (getDirectory throw, write throw,
  cleanup throw) that `opfs.browser.test.ts` cannot force against real OPFS. Reviewer flagged
  as "acceptable as-is, not insisting."

- **Finding 7 (keep).** Boot gates first paint on real side-effecting probes (GPU device
  create/destroy, OPFS write/delete) each launch. Kept: plan item 4 makes `requestAdapter()`
  **and** `requestDevice()` plus the `createWritable` feature test the capability check;
  deferring them to `/diag` would contradict the plan and weaken the gate for the hard
  requirement. Future cheap win (not built): a per-session cache of a passing result so
  repeat in-session navigations skip the side effects — record as an option, not a change.

- **Finding 9 (keep).** `probeCamera`/`probeSpeech` are `async` without an `await`. Kept for
  uniformity: both satisfy the `CapabilityProbes` signature (`() => Promise<ProbeOutcome>`) and
  read alongside the genuinely async `probeWebGpu`/`probeOpfs`. Cosmetic; reviewer left it.

## Open questions — for the user

- **Capability gate policy (Finding 1 / product decision).** `capabilities.ts` now carries a
  per-capability `required` flag, currently `true` for all four (WebGPU, camera, OPFS, speech),
  so the gate = "all required probes pass" — behavior-identical to before, but the policy is now
  explicit and there is a seam for graceful degradation. This matches the documented spec
  (product.md "Platform requirements" and ADR 0002 both make all four hard requirements). The
  reviewer's concern — a speech-synthesis failure alone hard-gates the whole app — is a real
  product question but NOT one the plan decides: should a missing/failed `speechSynthesis` (or
  camera, on a review-only desktop that just reads sessions) degrade gracefully instead of
  showing the Unsupported screen? If yes, flip that capability's `required` to `false` and let
  the UI surface the degraded state. Left as a product call; no behavior changed here.
