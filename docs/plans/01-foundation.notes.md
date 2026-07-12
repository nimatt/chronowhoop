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
- **Assumption:** OPFS seam implemented with `no-restricted-syntax` only, not `no-restricted-globals`. Selectors match any `MemberExpression` whose property is `getDirectory` or `createWritable` (both `.name` for dot access and computed `['getDirectory']` string access), erroring everywhere except `src/core/storage/**` and `**/*.test.ts` via config-level `files`/`ignores`. `no-restricted-globals` was not useful: the touched global is `navigator`, which legit code uses for camera/speech probes. Trade-off: any unrelated object with a `getDirectory`/`createWritable` method would false-positive outside the allowlist — accept and revisit if it ever bites (the fix would be narrower selectors keyed on `navigator.storage`).
- **Assumption:** Core-is-framework-free rule scoped to `files: ['src/core/**']` with `no-restricted-imports` patterns `['svelte', 'svelte/*', '*.svelte', '**/*.svelte']`. Only import syntax is caught; a `require()` or dynamic `import()` of svelte would slip through — irrelevant in this ESM + lint-per-commit setup.
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
