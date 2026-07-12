# ChronoWhoop — project instructions

Web-based tiny-whoop lap timer: WebCodecs camera-based gate detection (CPU reduction), spoken lap times, OPFS storage, no backend, served as static assets from Cloudflare Workers. Read `docs/specs/product.md` before changing behavior.

## Stack

- TypeScript + Vite + Svelte 5 (runes), Vitest for tests
- Detection pipeline is pure TypeScript over WebCodecs capture (ADR 0009)
- Wrangler deploys the Vite build as Cloudflare Workers static assets, served at https://chronowhoop.com (Workers custom domain)
- Hosted on GitHub; CI and deploy-on-main run as GitHub Actions workflows
- PWA: service worker precaches the full bundle; app must work offline

## Architecture rules

- **Core logic is framework-free.** Lap semantics, record computation, crossing state machine, storage — plain TS modules with unit tests. Svelte components stay thin.
- **The capture pipeline reduces; the CPU state machine decides.** Capture (`MediaStreamTrackProcessor`) and per-frame reduction to per-strip motion energies live behind the lint-enforced seam in `src/core/detection/`; the rest of the app consumes `FrameSample` streams. The crossing state machine (direction, debounce, arming) is plain TypeScript, fed by those samples, and fully testable with synthetic strip-energy sequences.
- **Storage goes through one interface** (OPFS implementation today). No direct OPFS calls outside the storage module — this is the seam for future backend sync and desktop folder mirroring.
- **Records are computed, never stored.** Best lap / best three consecutive are derived from lap data on read.
- **Keep the frame ring-buffer seam.** The pipeline retains a short ring buffer of recent ROI frames so per-crossing video capture can be added later without restructuring.
- WebCodecs capture is the hard requirement (ADR 0009): detect support at startup and show a clear unsupported-browser screen.

## Documentation

- `docs/specs/` — behavior source of truth. Update the spec in the same change when behavior changes.
- `docs/decisions/` — ADRs, numbered `NNNN-slug.md`. Add one when reversing or making a significant architectural choice; never rewrite history in an existing ADR.
- `docs/plans/` — implementation plans.
- `docs/runbooks/` — operational guides.

## Non-goals (v1)

Multiple pilots, racegow.com submission integration, alternative capture routes beyond WebCodecs (the seam exists), cloud sync. Don't build toward these beyond the seams noted above.
