# 0005 — Stack: TypeScript + Vite + Svelte 5, Vitest, Wrangler

**Status:** accepted, 2026-07-12

## Context

The app is a static bundle with two distinct halves: a real-time WebGPU/canvas pipeline (wants no framework) and conventional UI (course list, session tables, settings).

## Decision

Svelte 5 (runes) for the UI — tiny runtime suited to a small PWA. Detection pipeline, lap semantics, records, and storage are framework-free TypeScript modules tested with Vitest. Vite builds; Wrangler deploys the output as Cloudflare Workers static assets.

## Consequences

- Svelte components stay thin; core logic never imports Svelte.
- No server-side code exists; "deploy" is a static upload.
