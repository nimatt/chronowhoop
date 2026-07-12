import { describe, expect, it } from 'vitest'
import {
  CameraService,
  DEFAULT_CAMERA_CONSTRAINTS,
  type CameraConstraints,
  type CameraState,
  type CameraStreamLike,
  type CameraTrackLike,
  type CameraTrackSettings,
} from './camera-service'

const namedError = (name: string, message: string) => Object.assign(new Error(message), { name })

interface FakeTrack extends CameraTrackLike {
  stopCount: number
}

function makeTrack(settings?: CameraTrackSettings, label?: string): FakeTrack {
  const track: FakeTrack = {
    label,
    stopCount: 0,
    stop() {
      track.stopCount++
    },
  }
  if (settings) track.getSettings = () => settings
  return track
}

function makeStream(...tracks: FakeTrack[]): CameraStreamLike {
  return {
    getTracks: () => tracks,
    getVideoTracks: () => tracks,
  }
}

function grantingService(stream: CameraStreamLike) {
  const calls: CameraConstraints[] = []
  const service = new CameraService({
    getUserMedia: async (constraints) => {
      calls.push(constraints)
      return stream
    },
  })
  return { service, calls }
}

function rejectingService(error: unknown) {
  return new CameraService<CameraStreamLike>({
    getUserMedia: async () => {
      throw error
    },
  })
}

function recordStatuses<S extends CameraStreamLike>(service: CameraService<S>): string[] {
  const statuses: string[] = []
  service.subscribe((state) => statuses.push(state.status))
  return statuses
}

describe('CameraService grant flow', () => {
  it('transitions idle → requesting → active and reports granted settings', async () => {
    const track = makeTrack(
      { width: 1280, height: 720, frameRate: 59.94, facingMode: 'environment', deviceId: 'cam-1' },
      'Back camera',
    )
    const { service } = grantingService(makeStream(track))
    const statuses = recordStatuses(service)

    expect(service.state).toEqual({ status: 'idle' })
    const state = await service.start()

    expect(statuses).toEqual(['requesting', 'active'])
    expect(state.status).toBe('active')
    if (state.status === 'active') {
      expect(state.granted).toEqual({
        width: 1280,
        height: 720,
        frameRate: 59.94,
        facingMode: 'environment',
        deviceId: 'cam-1',
        label: 'Back camera',
      })
    }
    expect(service.state).toBe(state)
  })

  it('requests environment facing, 60 fps and 1280x720 as ideals', async () => {
    const { service, calls } = grantingService(makeStream(makeTrack()))
    await service.start()
    expect(calls).toEqual([DEFAULT_CAMERA_CONSTRAINTS])
    expect(DEFAULT_CAMERA_CONSTRAINTS).toEqual({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        frameRate: { ideal: 60 },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    })
  })

  it('still activates when the track exposes no getSettings, keeping the label', async () => {
    const { service } = grantingService(makeStream(makeTrack(undefined, 'Cam')))
    const state = await service.start()
    expect(state).toMatchObject({ status: 'active', granted: { label: 'Cam' } })
  })

  it('falls back to getTracks() when the stream lacks getVideoTracks', async () => {
    const track = makeTrack({ width: 640, height: 480 }, 'Fallback cam')
    const { service } = grantingService({ getTracks: () => [track] })
    const state = await service.start()
    expect(state).toMatchObject({
      status: 'active',
      granted: { width: 640, height: 480, label: 'Fallback cam' },
    })
  })

  it('activates with empty granted settings when the stream has no tracks', async () => {
    const { service } = grantingService(makeStream())
    const state = await service.start()
    expect(state.status).toBe('active')
    if (state.status === 'active') expect(state.granted).toEqual({})
  })

  it('start() while active is a no-op returning the current state', async () => {
    const { service, calls } = grantingService(makeStream(makeTrack()))
    const first = await service.start()
    const second = await service.start()
    expect(second).toBe(first)
    expect(calls).toHaveLength(1)
  })

  it('concurrent start() calls share one getUserMedia request', async () => {
    const { service, calls } = grantingService(makeStream(makeTrack()))
    const [first, second] = await Promise.all([service.start(), service.start()])
    expect(second).toBe(first)
    expect(calls).toHaveLength(1)
  })
})

describe('CameraService failure classification', () => {
  const cases: Array<{ error: unknown; status: string; kind: string }> = [
    {
      error: namedError('NotAllowedError', 'Permission denied'),
      status: 'denied',
      kind: 'denied',
    },
    // Message text never affects classification — "dismissed" and "denied by
    // system" map like any other NotAllowedError.
    {
      error: namedError('NotAllowedError', 'Permission dismissed'),
      status: 'denied',
      kind: 'denied',
    },
    {
      error: namedError('NotAllowedError', 'Permission denied by system'),
      status: 'denied',
      kind: 'denied',
    },
    {
      error: namedError('SecurityError', 'disabled by permissions policy'),
      status: 'blocked',
      kind: 'insecure-context',
    },
    {
      error: namedError('NotFoundError', 'Requested device not found'),
      status: 'unavailable',
      kind: 'no-camera',
    },
    {
      error: namedError('NotReadableError', 'Could not start video source'),
      status: 'unavailable',
      kind: 'camera-in-use',
    },
    {
      error: namedError('OverconstrainedError', 'width'),
      status: 'unavailable',
      kind: 'constraints-unsatisfiable',
    },
    {
      error: namedError('AbortError', 'Starting videoinput failed'),
      status: 'unavailable',
      kind: 'aborted',
    },
    { error: new Error('wat'), status: 'unavailable', kind: 'unknown' },
    { error: 'not even an Error', status: 'unavailable', kind: 'unknown' },
  ]

  it.each(cases)('maps $error to $status/$kind', async ({ error, status, kind }) => {
    const service = rejectingService(error)
    const state = await service.start()
    expect(state.status).toBe(status)
    if ('error' in state) {
      expect(state.error.kind).toBe(kind)
      expect(state.error.message).toBeTruthy()
    } else {
      throw new Error(`expected an error-carrying state, got ${state.status}`)
    }
  })

  it('goes unavailable without requesting when getUserMedia is missing', async () => {
    const service = new CameraService({})
    const statuses = recordStatuses(service)
    const state = await service.start()
    expect(state).toMatchObject({
      status: 'unavailable',
      error: { kind: 'getusermedia-unsupported' },
    })
    expect(statuses).toEqual(['unavailable'])
  })

  it('goes unavailable when mediaDevices itself is missing', async () => {
    const service = new CameraService(undefined)
    const state = await service.start()
    expect(state).toMatchObject({
      status: 'unavailable',
      error: { kind: 'getusermedia-unsupported' },
    })
  })

  it('can retry after a denial', async () => {
    let attempts = 0
    const track = makeTrack()
    const service = new CameraService({
      getUserMedia: async () => {
        attempts++
        if (attempts === 1) throw namedError('NotAllowedError', 'Permission denied')
        return makeStream(track)
      },
    })
    expect((await service.start()).status).toBe('denied')
    expect((await service.start()).status).toBe('active')
    expect(attempts).toBe(2)
  })
})

describe('CameraService teardown', () => {
  it('stop() stops every track and returns to idle', async () => {
    const trackA = makeTrack()
    const trackB = makeTrack()
    const { service } = grantingService(makeStream(trackA, trackB))
    await service.start()

    service.stop()
    expect(service.state).toEqual({ status: 'idle' })
    expect(trackA.stopCount).toBe(1)
    expect(trackB.stopCount).toBe(1)
  })

  it('stop() is idempotent — tracks are not re-stopped', async () => {
    const track = makeTrack()
    const { service } = grantingService(makeStream(track))
    await service.start()
    service.stop()
    service.stop()
    expect(track.stopCount).toBe(1)
    expect(service.state).toEqual({ status: 'idle' })
  })

  it('stop() is safe in idle and error states', async () => {
    const idle = new CameraService({})
    expect(() => idle.stop()).not.toThrow()
    expect(idle.state).toEqual({ status: 'idle' })

    const denied = rejectingService(namedError('NotAllowedError', 'Permission denied'))
    await denied.start()
    denied.stop()
    expect(denied.state).toEqual({ status: 'idle' })
  })

  it('stop() during requesting tears down the late-arriving stream and stays idle', async () => {
    const track = makeTrack()
    let grant: (stream: CameraStreamLike) => void = () => {}
    const service = new CameraService({
      getUserMedia: () => new Promise<CameraStreamLike>((resolve) => (grant = resolve)),
    })

    const pending = service.start()
    expect(service.state.status).toBe('requesting')
    service.stop()
    grant(makeStream(track))

    const state = await pending
    expect(state).toEqual({ status: 'idle' })
    expect(service.state).toEqual({ status: 'idle' })
    expect(track.stopCount).toBe(1)
  })

  it('stop() during requesting suppresses a late rejection', async () => {
    let reject: (error: unknown) => void = () => {}
    const service = new CameraService({
      getUserMedia: () => new Promise<CameraStreamLike>((_, rej) => (reject = rej)),
    })
    const pending = service.start()
    service.stop()
    reject(namedError('NotAllowedError', 'Permission denied'))

    expect(await pending).toEqual({ status: 'idle' })
    expect(service.state).toEqual({ status: 'idle' })
  })

  it('a start() after stop()-during-requesting issues a fresh request', async () => {
    const staleTrack = makeTrack()
    const freshTrack = makeTrack()
    const grants: Array<(stream: CameraStreamLike) => void> = []
    const service = new CameraService({
      getUserMedia: () => new Promise<CameraStreamLike>((resolve) => grants.push(resolve)),
    })

    const stale = service.start()
    service.stop()
    const fresh = service.start()
    expect(grants).toHaveLength(2)

    grants[0](makeStream(staleTrack))
    grants[1](makeStream(freshTrack))

    // The cancelled request resolves with whatever the service state is at
    // settlement time (the fresh request had already begun), never 'active'
    // for the stale stream.
    expect((await stale).status).toBe('requesting')
    expect((await fresh).status).toBe('active')
    expect(staleTrack.stopCount).toBe(1)
    expect(freshTrack.stopCount).toBe(0)
    expect(service.state).toBe(await fresh)
  })
})

describe('CameraService subscription', () => {
  it('unsubscribed listeners stop receiving states', async () => {
    const { service } = grantingService(makeStream(makeTrack()))
    const seen: CameraState<CameraStreamLike>[] = []
    const unsubscribe = service.subscribe((state) => seen.push(state))
    unsubscribe()
    await service.start()
    expect(seen).toEqual([])
  })
})
