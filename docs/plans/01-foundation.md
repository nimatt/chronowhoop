# Phase 1 — Foundation: scaffold, deploy loop, capability gate, verification rig

## Goal

A deployed HTTPS URL where any phone either reaches a (mostly empty) supported app shell or a correct unsupported-browser screen — and a CI that has already proven it can run every category of test the project will ever need, before any code that needs them exists.

## Scope

**In:** repo scaffold, deploy pipeline, capability gate, routing skeleton, module-seam enforcement, service worker skeleton with build-id visibility, CI with all test rigs spiked, device procurement.

**Out:** any camera, WebGPU pipeline, detection, storage, or product feature code. The WebGPU and OPFS tests in this phase are hello-world spikes, not product code.

## Work items (dependency order)

1. **Scaffold:** Vite + Svelte 5 (runes) + TypeScript strict + Vitest. Folder layout enforcing the CLAUDE.md split from commit one: `src/core/**` (framework-free: detection, session, records, storage, speech-formatting) vs `src/ui/**` (Svelte). `src/core/storage/` exists from day one — it is the *only* place OPFS APIs may be touched (see item 2), and the capability feature-test lives inside it as the embryonic storage module. Check script: typecheck + lint + test + build.
2. **Seam enforcement (lint, not convention):**
   - `src/core/**` must never import `svelte` (eslint `no-restricted-imports` or dependency-cruiser).
   - `navigator.storage.getDirectory` / OPFS APIs usable only inside `src/core/storage/**` and test files (`no-restricted-globals`/`no-restricted-syntax` with an explicit, reviewed allowlist — no incremental eslint-disable trail). The Phase 2 `/diag` OPFS probe will call into `src/core/storage/` probe functions, not raw APIs.
3. **Deploy pipeline:** `wrangler.jsonc` for Cloudflare Workers static assets with **chronowhoop.com** attached as the Workers custom domain; `npm run deploy` working locally day one, plus a GitHub Actions workflow deploying on push to `main` (Cloudflare API token as a repo secret). https://chronowhoop.com is the on-device test loop for the entire project (getUserMedia and WebGPU require a secure context).
4. **Capability-check module** (`src/core`): async probes for WebGPU — `requestAdapter()` **and** `requestDevice()` (adapter success with device failure is a real failure mode: blocklisted GPUs, driver limits; revisit requested limits in Phase 3 once the pipeline's needs are known) — `getUserMedia` presence, OPFS (`getDirectory` + `createWritable` feature test via the storage module), `speechSynthesis`. Probes injected so the module is unit-testable without real feature absence.
5. **Unsupported-browser screen** listing supported browsers per ADR 0002, wired to the capability gate at startup. The screen shows **per-capability probe results** and links to `/diag`. The gate **exempts `/diag` and `/lab`** — their entire purpose is diagnosing devices that fail or partially fail it.
6. **Routing decision + skeleton:** specs name no routing model — decide (recommendation: minimal hand-rolled hash router) and document. Register: capability-fail, home placeholder, and reserved hidden routes `/diag` and `/lab`.
7. **Web app manifest** (name, icons, `display: standalone`) so installability exists from the start.
8. **Service worker skeleton** (vite-plugin-pwa or hand-rolled): full-bundle precache, explicit prompt-for-update flow, disabled in dev. Landing this now means every deploy exercises the PWA update path for months before v1. Two guardrails so the SW never taxes the high-iteration spike phases:
   - A **visible build id / short commit hash** in the shell footer and on `/diag`, so the running version is always identifiable on-device.
   - A **one-tap "update now"** action (immediate activate + reload) so the prompt flow costs at most one tap per deploy.
9. **CI verification spikes** on GitHub Actions (the de-risking heart of this phase — run all three, record results):
   - Node/Vitest unit job (trivially green).
   - Playwright (or Vitest browser mode) browser-context job in **Chromium** (gating) and **WebKit** (informational, per ADR 0006 — cheap to run, so keep it green when it's free): write/read a file via OPFS. OPFS is untestable in jsdom.
   - Headless Chromium **WebGPU** job: hello-world compute shader dispatch + `mapAsync` buffer readback. GitHub-hosted runners have no GPU, so this means SwiftShader/software WebGPU (`--enable-unsafe-swiftshader` or equivalent flags) — if that fails, decide the fallback now (self-hosted GPU runner or a mandatory local pre-merge GPU suite) — before any WGSL exists.
10. **Document the test taxonomy** (unit / browser-contract / GPU-golden / on-device self-test / video-E2E / manual device checklist) in the repo.
11. **Device procurement:** confirm the physical Android Chrome phone is in hand and loads the deployed URL. This is Phase 2's entry criterion; cloud device farms cannot substitute (no real rear camera at a real gate). An iOS Safari 26 device is optional (ADR 0006): if one is around, load the URL on it too; if not, iOS-specific probes and checks throughout the plans are simply skipped.

## Verification

- Deployed URL loads on the Android phone (and any available iOS device); an intentionally unsupported browser (e.g. Firefox) shows the explanatory screen with per-probe results; `/diag` route is reachable even there.
- CI green across all three rigs; a seeded violation (core importing svelte; OPFS call in a component) fails lint.
- Deploying a second build produces the update prompt on a client running the first; build id on `/diag` matches the deploy; "update now" activates in one tap.

## Risks retired

- **WebGPU-may-not-run-in-CI** — answered before a line of WGSL exists; the whole automated GPU/E2E strategy hinges on it.
- **Seam erosion** — the core/UI and storage boundaries become mechanical rules before any consumer code exists, with the OPFS exemption surface (`src/core/storage/`) deliberate rather than an eslint-disable trail.
- **Stale-bundle hauntings / which-build-is-this confusion** — the SW update path is exercised by every deploy, and the build id makes on-device state legible.
- **No-secure-context dead end** — on-device testing possible from day one.
- **Hardware availability as silent assumption** — the Android target device is an explicit exit item.
