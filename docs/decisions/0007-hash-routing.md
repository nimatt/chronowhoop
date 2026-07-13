# 0007 — Minimal hand-rolled hash router, no routing library

**Status:** accepted, 2026-07-12; amended 2026-07-13 (param routes)

> **Amendment (2026-07-13, Phase 6):** the "revisit when routes gain params" moment arrived with courses and sessions. The router stays hand-rolled: `Route` became a discriminated union (`home | diag | lab | fly/<courseId> | course/<id> | session/<id> | course/new | course/<id>/edit`), the parser splits hash segments by hand, and a `hashFor(route)` helper is the single source of hash strings for links and navigation. Unknown or malformed hashes still map to home; plain `#/fly` no longer exists (the fly flow is course-backed). Still no guards, no history abstraction, no library — the seam and the escape hatch below are unchanged.

## Context

The specs name no routing model. The app has roughly three visible routes (home, and later the product screens) plus the hidden diagnostics routes `/diag` and `/lab`. It ships as static assets from Cloudflare Workers, so path-style URLs would need server-side rewrite handling that hash URLs avoid entirely. The capability gate must exempt `/diag` and `/lab` — their whole purpose is diagnosing devices that fail or partially fail the gate ([0002](0002-webgpu-hard-requirement.md)).

## Decision

Hand-rolled hash router, no library. The pure logic — hash → route mapping and the gate-exemption decision — lives as framework-free TypeScript in `src/core/routing/` and is unit-tested (`route.ts`, `route.test.ts`), including `shouldShowUnsupportedScreen`. The reactive binding is a `$state` route plus a `<svelte:window onhashchange>` in the shell; there is no separate UI router module. Routes: `#/` (home), `#/diag`, `#/lab`; capability-fail is a gate *state*, not a route.

## Consequences

- No routing dependency and no server-side path handling — hash URLs are served by the static bundle as-is.
- Deep links are `#/`-style; adding a route is a switch-case edit in `route.ts`.
- The gate-exemption rule is testable in plain TS, decoupled from Svelte.
- If the route table ever grows complex enough to hurt (params, guards, programmatic navigation), adopting a library is a contained change behind the same seam.
