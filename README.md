# ChronoWhoop

A web-based lap timer for single tiny-whoop drone racing. Point a phone camera at the start/finish gate from the side, draw a region of interest, arm the timer, and fly. Every lap time is spoken aloud so you never need to look at a screen mid-flight.

Built for solo practice and self-competition, e.g. entering your times at [racegow.com](https://www.racegow.com/).

**Status: design phase — no code yet.** See [docs/](docs/) for specs and decisions.

## How it works

1. Create a **course** (name, crossing direction, minimum lap time).
2. Start a **session**: prop the phone next to the gate, adjust the camera region of interest, verify detection in test mode (wave a hand — it beeps).
3. **Arm**. The first gate crossing starts the clock; every subsequent crossing in the configured direction completes a lap.
4. Each lap time is announced via speech synthesis ("fourteen three", "best fourteen one").
5. Review the session: all laps with time of day, best lap and best three consecutive laps highlighted, per session and all-time per course.

Detection runs entirely in the browser using WebGPU: frame differencing against a running background model, with the region of interest divided into strips so that movement direction can be derived from the order in which strips light up.

## Requirements

- A browser with **WebGPU**, **camera access**, and **OPFS**: Chrome/Edge on desktop or Android, Safari 26+ on iOS/macOS. Unsupported browsers get a clear error screen — there is no fallback pipeline.
- No account, no backend. All data lives on the device (origin-private file system) as JSON; export/import moves it between devices.
- Works fully offline after first load (installable PWA).

## Development

Planned stack: TypeScript, Vite, Svelte 5, Vitest; deployed as static assets on Cloudflare Workers via Wrangler.

```sh
npm install
npm run dev      # local dev server
npm test         # unit tests
npm run build    # production build
npm run deploy   # wrangler deploy
```

## Documentation

| | |
|---|---|
| [docs/specs/](docs/specs/) | Product and technical specs (source of truth for behavior) |
| [docs/decisions/](docs/decisions/) | Architecture decision records |
| [docs/plans/](docs/plans/) | Implementation plans |
| [docs/runbooks/](docs/runbooks/) | Operational guides (deploy, debug) |
