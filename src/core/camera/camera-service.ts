import type { AutoControlSettings, AutoControlTrackLike } from './auto-control-probe'

export interface CameraTrackSettings extends AutoControlSettings {
  width?: number
  height?: number
  frameRate?: number
  facingMode?: string
  deviceId?: string
}

export interface CameraTrackLike extends AutoControlTrackLike {
  readonly label?: string
  stop(): void
  getSettings?(): CameraTrackSettings
  addEventListener?(type: 'ended', listener: () => void): void
  removeEventListener?(type: 'ended', listener: () => void): void
}

export interface CameraStreamLike {
  getTracks(): CameraTrackLike[]
  getVideoTracks?(): CameraTrackLike[]
}

export interface CameraConstraints {
  audio: false
  video: {
    facingMode: { ideal: string }
    frameRate: { ideal: number }
    width: { ideal: number }
    height: { ideal: number }
  }
}

export interface CameraMediaDevicesLike<S extends CameraStreamLike = MediaStream> {
  getUserMedia?(constraints: CameraConstraints): Promise<S>
}

// The detection ROI is downscaled later, so resolution is not critical; 720p
// ideal is a widely granted middle ground that keeps per-frame upload cheap.
export const DEFAULT_CAMERA_CONSTRAINTS: CameraConstraints = {
  audio: false,
  video: {
    facingMode: { ideal: 'environment' },
    frameRate: { ideal: 60 },
    width: { ideal: 1280 },
    height: { ideal: 720 },
  },
}

// Discriminated error kind for the UI to map to per-OS re-enable instructions;
// the instruction text itself is a UI concern.
export type CameraErrorKind =
  | 'denied'
  | 'insecure-context'
  | 'no-camera'
  | 'camera-in-use'
  | 'constraints-unsatisfiable'
  | 'aborted'
  | 'getusermedia-unsupported'
  | 'track-ended'
  | 'unknown'

export interface CameraError {
  kind: CameraErrorKind
  message: string
}

export interface GrantedCameraSettings {
  width?: number
  height?: number
  frameRate?: number
  facingMode?: string
  deviceId?: string
  label?: string
}

type CameraFailureState =
  | { status: 'denied'; error: CameraError }
  | { status: 'blocked'; error: CameraError }
  | { status: 'unavailable'; error: CameraError }

export type CameraState<S extends CameraStreamLike = MediaStream> =
  | { status: 'idle' }
  | { status: 'requesting' }
  | { status: 'active'; stream: S; granted: GrantedCameraSettings }
  | CameraFailureState

export type CameraStateListener<S extends CameraStreamLike = MediaStream> = (
  state: CameraState<S>,
) => void

function errorName(error: unknown): string {
  const name = (error as { name?: unknown } | null | undefined)?.name
  return typeof name === 'string' ? name : ''
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// getUserMedia rejection → state + kind, classified by error.name only.
// NotAllowedError covers "denied just now", "prompt dismissed", and "blocked
// in site/OS settings" alike; Chromium's message text could sub-split those
// but is locale/version-fragile, so the UI instructions cover all of them for
// 'denied' and the raw message is surfaced alongside. permissions.query can
// sharpen this later if a real need shows up.
function classifyFailure(error: unknown): CameraFailureState {
  const message = errorMessage(error)
  const state = (
    status: CameraFailureState['status'],
    kind: CameraErrorKind,
  ): CameraFailureState => ({ status, error: { kind, message } })

  switch (errorName(error)) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return state('denied', 'denied')
    case 'SecurityError':
      return state('blocked', 'insecure-context')
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return state('unavailable', 'no-camera')
    case 'NotReadableError':
    case 'TrackStartError':
      return state('unavailable', 'camera-in-use')
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return state('unavailable', 'constraints-unsatisfiable')
    case 'AbortError':
      return state('unavailable', 'aborted')
    default:
      return state('unavailable', 'unknown')
  }
}

// Only the zero-argument `new CameraService()` reaches this default, and there
// S is MediaStream — matching what the real getUserMedia resolves with.
function defaultMediaDevices<S extends CameraStreamLike>(): CameraMediaDevicesLike<S> | undefined {
  const global = globalThis as { navigator?: { mediaDevices?: unknown } }
  return global.navigator?.mediaDevices as CameraMediaDevicesLike<S> | undefined
}

function stopTracks(stream: CameraStreamLike): void {
  for (const track of stream.getTracks()) track.stop()
}

function readGranted(stream: CameraStreamLike): GrantedCameraSettings {
  const track = stream.getVideoTracks?.()[0] ?? stream.getTracks()[0]
  if (!track) return {}
  const settings: CameraTrackSettings =
    typeof track.getSettings === 'function' ? track.getSettings() : {}
  return {
    width: settings.width,
    height: settings.height,
    frameRate: settings.frameRate,
    facingMode: settings.facingMode,
    deviceId: settings.deviceId,
    label: track.label,
  }
}

// Owns the MediaStream; consumers attach it to a video element themselves and
// call stop() on navigation/unmount (safe in any state, idempotent).
// Generic over the stream type so tests inject structural fakes while
// real-API consumers see plain `MediaStream` states without casting.
export class CameraService<S extends CameraStreamLike = MediaStream> {
  #mediaDevices: CameraMediaDevicesLike<S> | undefined
  #state: CameraState<S> = { status: 'idle' }
  #listeners = new Set<CameraStateListener<S>>()
  #pending: Promise<CameraState<S>> | null = null
  // Bumped by stop(); an in-flight request that outlives its generation
  // discards (and tears down) whatever getUserMedia eventually returns.
  #generation = 0
  #unwatchTrackEnded: (() => void) | null = null

  constructor(mediaDevices: CameraMediaDevicesLike<S> | undefined = defaultMediaDevices<S>()) {
    this.#mediaDevices = mediaDevices
  }

  get state(): CameraState<S> {
    return this.#state
  }

  subscribe(listener: CameraStateListener<S>): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  start(): Promise<CameraState<S>> {
    if (this.#state.status === 'active') return Promise.resolve(this.#state)
    if (this.#pending) return this.#pending
    const request = this.#request().finally(() => {
      if (this.#pending === request) this.#pending = null
    })
    this.#pending = request
    return request
  }

  stop(): void {
    this.#generation++
    this.#pending = null
    this.#unwatchTrackEnded?.()
    this.#unwatchTrackEnded = null
    if (this.#state.status === 'active') stopTracks(this.#state.stream)
    if (this.#state.status !== 'idle') this.#setState({ status: 'idle' })
  }

  async #request(): Promise<CameraState<S>> {
    const mediaDevices = this.#mediaDevices
    if (typeof mediaDevices?.getUserMedia !== 'function') {
      return this.#setState({
        status: 'unavailable',
        error: {
          kind: 'getusermedia-unsupported',
          message: 'navigator.mediaDevices.getUserMedia is not available',
        },
      })
    }

    const generation = this.#generation
    this.#setState({ status: 'requesting' })

    let stream: S
    try {
      stream = await mediaDevices.getUserMedia(DEFAULT_CAMERA_CONSTRAINTS)
    } catch (error) {
      if (generation !== this.#generation) return this.#state
      return this.#setState(classifyFailure(error))
    }

    if (generation !== this.#generation) {
      stopTracks(stream)
      return this.#state
    }
    this.#watchTrackEnded(stream)
    return this.#setState({ status: 'active', stream, granted: readGranted(stream) })
  }

  // The video track can end outside stop() — device unplugged, OS revoked the
  // permission mid-run, another app claimed the camera. Without this the
  // service would keep reporting a dead stream as 'active'; instead the death
  // surfaces to subscribers as a distinct failure state ('unavailable' /
  // 'track-ended'), never as 'idle' — 'idle' is reserved for deliberate
  // stop(), so consumers can tell external death from their own teardown.
  #watchTrackEnded(stream: S): void {
    const track = stream.getVideoTracks?.()[0] ?? stream.getTracks()[0]
    if (!track?.addEventListener || !track.removeEventListener) return
    const generation = this.#generation
    const onEnded = () => {
      if (generation !== this.#generation) return
      this.#unwatchTrackEnded = null
      track.removeEventListener?.('ended', onEnded)
      this.#generation++
      this.#pending = null
      stopTracks(stream)
      this.#setState({
        status: 'unavailable',
        error: {
          kind: 'track-ended',
          message: 'camera track ended outside stop() (device lost, revoked, or claimed elsewhere)',
        },
      })
    }
    track.addEventListener('ended', onEnded)
    this.#unwatchTrackEnded = () => track.removeEventListener?.('ended', onEnded)
  }

  #setState(state: CameraState<S>): CameraState<S> {
    this.#state = state
    for (const listener of this.#listeners) listener(state)
    return state
  }
}
