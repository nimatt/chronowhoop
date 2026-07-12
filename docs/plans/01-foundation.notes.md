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
