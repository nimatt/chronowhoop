# WebGPU FAIL on Chrome for Linux: "no adapter"

## Symptom

On desktop Chrome for Linux, the capability gate (or `/diag`) shows WebGPU
FAIL. Two variants:

- **"no core WebGPU adapter, but a compatibility adapter exists — … enable
  chrome://flags/#enable-vulkan"** — the common case; follow the fix below.
- **"requestAdapter() returned no adapter"** — no adapter at all; usually a
  driver problem, see the last section.

## Cause

Chrome's core WebGPU adapter on Linux is backed by Vulkan (Dawn's Linux
backend). On some GPU/driver combinations Chrome ships with Vulkan disabled:
`chrome://gpu` then shows `WebGPU: Hardware accelerated` (the feature is not
blocklisted) alongside `Vulkan: Disabled`, and a default core-mode
`requestAdapter()` resolves to `null`. Only the GLES-backed *compatibility
mode* adapter exists in that state, which the app does not use — the probe
requests it solely to sharpen the error message (`hasCompatibilityAdapter` in
`src/core/capabilities/capabilities.ts`).

## Fix

1. Open `chrome://flags`, set **`#enable-vulkan`** to Enabled, relaunch
   Chrome. (`#enable-unsafe-webgpu` is not needed when `chrome://gpu` already
   shows WebGPU as Hardware accelerated.)
2. Confirm `chrome://gpu` now shows `Vulkan: Enabled`.
3. Reload the app, or open `/diag` and tap "Re-run probes" — WebGPU should
   PASS.

Command-line equivalent: `google-chrome --enable-features=Vulkan`.

## If Vulkan stays disabled or no adapter exists at all

The driver layer is the problem, not Chrome:

- `vulkaninfo --summary` (package `vulkan-tools`) must succeed. If not,
  install the Vulkan ICD for your GPU (`mesa-vulkan-drivers` for
  Intel/AMD, the NVIDIA driver's Vulkan component for NVIDIA).
- NVIDIA + Wayland has been the most common stubborn combination; try an X11
  session or a newer driver.
- Quick console check on any page of the app:
  `await navigator.gpu.requestAdapter()` (expect an adapter, not `null`).

## Follow-up noted elsewhere

Accepting a compatibility-mode adapter as a fallback (the pipeline is
compute-only, which largely works under compat mode) is an open Phase 3
question — see `docs/plans/01-foundation.notes.md`. Until then, core WebGPU
is required.
