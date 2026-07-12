# 0001 — Phone-first installable PWA, desktop also supported

**Status:** accepted, 2026-07-12

## Context

The device at the track is most naturally a phone propped beside the gate; sessions are also reviewed on desktop. Venues (gyms, basements) often lack connectivity.

## Decision

Target phones first (Android Chrome, iOS Safari 26+) with desktop Chromium as a fully supported second platform. Ship as an installable PWA whose service worker precaches the entire bundle, so the app works with zero connectivity after first load. Hold a Screen Wake Lock while armed.

## Consequences

- The File System Access directory picker (desktop-only) cannot be the primary storage — led to [0004](0004-opfs-storage.md).
- iOS floor is Safari 26 (first with WebGPU); older iPhones are unsupported.
- Cloudflare Workers serves only static assets; no server code.
