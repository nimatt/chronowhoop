# ChronoWhoop — project instructions

Web-based tiny-whoop lap timer: WebGPU camera-based gate detection, spoken lap times, OPFS storage, no backend, served as static assets from Cloudflare Workers. Read `docs/specs/product.md` before changing behavior.

## Stack

- TypeScript + Vite + Svelte 5 (runes), Vitest for tests
- WGSL shaders for the detection pipeline
- Wrangler deploys the Vite build as Cloudflare Workers static assets, served at https://chronowhoop.com (Workers custom domain)
- Hosted on GitHub; CI and deploy-on-main run as GitHub Actions workflows
- PWA: service worker precaches the full bundle; app must work offline

## Architecture rules

- **Core logic is framework-free.** Lap semantics, record computation, crossing state machine, storage — plain TS modules with unit tests. Svelte components stay thin.
- **GPU does per-frame reduction only; decisions happen on CPU.** The WebGPU pipeline reduces each camera frame to a small per-strip motion-energy buffer. The crossing state machine (direction, debounce, arming) is TypeScript, fed by that buffer, and fully testable with synthetic strip-energy sequences.
- **Storage goes through one interface** (OPFS implementation today). No direct OPFS calls outside the storage module — this is the seam for future backend sync and desktop folder mirroring.
- **Records are computed, never stored.** Best lap / best three consecutive are derived from lap data on read.
- **Keep the frame ring-buffer seam.** The pipeline retains a short ring buffer of recent ROI frames so per-crossing video capture can be added later without restructuring.
- WebGPU is a hard requirement: detect support at startup and show a clear unsupported-browser screen. No CPU fallback pipeline.

## Documentation

- `docs/specs/` — behavior source of truth. Update the spec in the same change when behavior changes.
- `docs/decisions/` — ADRs, numbered `NNNN-slug.md`. Add one when reversing or making a significant architectural choice; never rewrite history in an existing ADR.
- `docs/plans/` — implementation plans.
- `docs/runbooks/` — operational guides.

## Non-goals (v1)

Multiple pilots, racegow.com submission integration, CPU detection fallback, cloud sync. Don't build toward these beyond the seams noted above.
