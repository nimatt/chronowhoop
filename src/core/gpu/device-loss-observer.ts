// Device-loss observation (device-spike work item 6): hook device.lost and
// report when/why it fires while the user backgrounds the app, locks the
// screen, or runs the 5-minute sustain. Facts only — Phase 3 builds the
// recreation path.

import type { ClockLike } from '../frame-loop/frame-loop'
import { defaultClock } from '../frame-loop/frame-loop'

export interface DeviceLossEvent {
  at: number
  // GPUDeviceLostReason: 'unknown' | 'destroyed'.
  reason: string
  message: string
}

// Structural seam over GPUDevice so unit tests inject fake lost promises.
export interface LossObservableDevice {
  lost: Promise<{ reason: string; message: string }>
}

// device.lost settles at most once and never rejects (per the WebGPU spec),
// so onLoss fires at most once per observed device.
export function observeDeviceLoss(
  device: LossObservableDevice,
  onLoss: (event: DeviceLossEvent) => void,
  clock: ClockLike = defaultClock(),
): void {
  void device.lost.then((info) =>
    onLoss({ at: clock.now(), reason: info.reason, message: info.message }),
  )
}
