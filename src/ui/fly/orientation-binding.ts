// Orientation app-state binding (detection.md "Orientation"): the ROI is
// bound to the device orientation captured when the camera starts; on a
// change the app warns and invalidates detection until the setup orientation
// is restored — the ROI is never remapped across orientations. This module is
// the pure decision half; fly-session.svelte.ts owns the wiring (matchMedia
// listener, detector detach/re-attach, background reset).

export type Orientation = 'portrait' | 'landscape'

export const ORIENTATION_QUERY = '(orientation: portrait)'

// The slice of MediaQueryList the binding needs — injectable so tests (and
// non-window environments) can drive orientation changes deterministically.
export interface OrientationQueryLike {
  readonly matches: boolean
  addEventListener(type: 'change', listener: () => void): void
  removeEventListener(type: 'change', listener: () => void): void
}

export type OrientationMatchMedia = (query: string) => OrientationQueryLike

export function orientationFromPortraitMatch(matchesPortrait: boolean): Orientation {
  return matchesPortrait ? 'portrait' : 'landscape'
}

// The binding while the camera runs; null while it does not (no ROI in use,
// orientation changes are irrelevant).
export interface OrientationBinding {
  readonly bound: Orientation
  readonly mismatch: boolean
}

// What an observed orientation demands of the caller:
// - 'invalidate' — the device left the bound orientation: warn and detach
//   detection (crossings during the mismatch are lost, per spec).
// - 'restore' — back in the bound orientation: clear the warning, reset the
//   background (it absorbed rotated frames), re-attach detection.
// - 'none' — no transition (unbound, or the mismatch state is unchanged).
export type OrientationEffect = 'none' | 'invalidate' | 'restore'

export function orientationEffect(
  binding: OrientationBinding | null,
  current: Orientation,
): OrientationEffect {
  if (binding === null) return 'none'
  const mismatch = current !== binding.bound
  if (mismatch === binding.mismatch) return 'none'
  return mismatch ? 'invalidate' : 'restore'
}
