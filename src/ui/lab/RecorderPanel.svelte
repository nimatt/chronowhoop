<script lang="ts">
  import { ENERGY_JSON_FORMAT_VERSION, encodeEnergyJson, type EnergyJsonFrame } from '../../core/detection/energy-json'
  import {
    ContinuousRecorder,
    DEFAULT_CONTINUOUS_RECORDER_MAX_FRAMES,
    snapshotRingClip,
  } from '../../core/detection/recorder'
  import { errorText } from '../diag/format'
  import { downloadBlob } from '../shared/download'
  import { timestampedFilename } from './filenames'
  import type { CaptureSession } from '../shared/capture-session'

  let { session }: { session: CaptureSession } = $props()

  // Keeps ~30 s at 60 fps of recent FrameSamples for the energy-JSON
  // convenience capture. Plain array, appended per-frame — never reactive.
  const ENERGY_SAMPLE_CAP = 1800

  // Replaced wholesale by Discard — a fresh instance is the one recovery that
  // works in every recorder state (stop() throws on zero frames and stays
  // recording, so a wedged or unwanted recording can't rely on it).
  let recorder = new ContinuousRecorder()
  let energySamples: EnergyJsonFrame[] = []

  let recordingContinuous = $state(false)
  let continuousFrames = $state(0)
  let mismatchedDrops = $state(0)
  let ringFrames = $state(0)
  let energySampleCount = $state(0)
  let truncationNotice = $state<string | null>(null)
  let mismatchNotice = $state<string | null>(null)
  let actionError = $state<string | null>(null)

  $effect(() => {
    const offFrame = session.addFrameListener((frame) => {
      if (recorder.recording) recorder.add(frame)
    })
    const offSample = session.addSampleListener((sample) => {
      energySamples.push({
        captureTimeMs: sample.captureTimeMs,
        energies: Array.from(sample.energies),
      })
      if (energySamples.length > ENERGY_SAMPLE_CAP) energySamples.shift()
    })
    const pollTimer = setInterval(() => {
      continuousFrames = recorder.frameCount
      mismatchedDrops = recorder.droppedMismatchedFrames
      ringFrames = session.ringBuffer()?.size ?? 0
      energySampleCount = energySamples.length
    }, 1000)
    return () => {
      offFrame()
      offSample()
      clearInterval(pollTimer)
    }
  })

  // The energy-JSON collection is only honest under one tunables snapshot
  // (the serialized document embeds it as provenance, and mixed stripCounts
  // would not even validate), so any tunables change restarts the window.
  $effect(() => {
    void session.tunables
    energySamples = []
    energySampleCount = 0
  })

  function refreshCounts() {
    continuousFrames = recorder.frameCount
    mismatchedDrops = recorder.droppedMismatchedFrames
    ringFrames = session.ringBuffer()?.size ?? 0
    energySampleCount = energySamples.length
  }

  const ringAvailable = $derived(session.captureRunning || ringFrames > 0)

  function saveRingClip() {
    actionError = null
    const ring = session.ringBuffer()
    if (ring === null) {
      actionError = 'no pipeline yet — start the camera first'
      return
    }
    try {
      const bytes = snapshotRingClip(ring, { recordedBy: 'lab', mode: 'ring' })
      downloadBlob(timestampedFilename('clip', 'cwclip'), bytes)
    } catch (error) {
      actionError = errorText(error)
    }
  }

  function startContinuous() {
    actionError = null
    truncationNotice = null
    mismatchNotice = null
    try {
      recorder.start()
      recordingContinuous = true
    } catch (error) {
      actionError = errorText(error)
    }
    refreshCounts()
  }

  function stopContinuous() {
    actionError = null
    const wasTruncated = recorder.truncated
    const droppedMismatched = recorder.droppedMismatchedFrames
    try {
      const bytes = recorder.stop({ recordedBy: 'lab', mode: 'continuous' })
      downloadBlob(timestampedFilename('clip', 'cwclip'), bytes)
      recordingContinuous = false
      if (wasTruncated) {
        truncationNotice =
          `Recording hit the ${recorder.maxFrames}-frame cap: the clip keeps the oldest ` +
          'contiguous frames and its conditions carry the truncation marker.'
      }
      if (droppedMismatched > 0) {
        mismatchNotice =
          `${droppedMismatched} frames were dropped because their dimensions no longer matched ` +
          "the recording's first frame (the ROI changed mid-recording); the clip's conditions " +
          'carry the count.'
      }
    } catch (error) {
      // Zero frames: the recorder stays recording so more frames can arrive.
      actionError = errorText(error)
    }
    refreshCounts()
  }

  function discardRecording() {
    actionError = null
    truncationNotice = null
    mismatchNotice = null
    recorder = new ContinuousRecorder()
    recordingContinuous = false
    refreshCounts()
  }

  function saveEnergyJson() {
    actionError = null
    try {
      const json = encodeEnergyJson({
        formatVersion: ENERGY_JSON_FORMAT_VERSION,
        tunables: session.tunables,
        frames: [...energySamples],
      })
      downloadBlob(timestampedFilename('energy', 'json'), json, 'application/json')
    } catch (error) {
      actionError = errorText(error)
    }
  }
</script>

<div class="controls">
  <button onclick={saveRingClip} disabled={!ringAvailable}>
    Save ring clip ({ringFrames} frames)
  </button>
  <button onclick={startContinuous} disabled={recordingContinuous || !session.captureRunning}>
    Start continuous
  </button>
  <button onclick={stopContinuous} disabled={!recordingContinuous}>
    Stop &amp; download ({continuousFrames} frames)
  </button>
  <button onclick={discardRecording} disabled={!recordingContinuous}>
    Discard recording
  </button>
  <button onclick={saveEnergyJson} disabled={energySampleCount === 0}>
    Save energy JSON ({energySampleCount} samples)
  </button>
</div>

{#if recordingContinuous && mismatchedDrops > 0}
  <p class="error">
    {mismatchedDrops} frames dropped: the ROI changed mid-recording, so incoming frame dimensions
    no longer match the recording's first frame. Stop to keep the matching prefix, or discard.
  </p>
{/if}
{#if actionError !== null}
  <p class="error">{actionError}</p>
{/if}
{#if truncationNotice !== null}
  <p class="error">{truncationNotice}</p>
{/if}
{#if mismatchNotice !== null}
  <p class="error">{mismatchNotice}</p>
{/if}

<p class="hint">
  Ring clip = the pipeline's last ~2 s of frames (the video-capture seam). Continuous mode tees
  every captured frame into a long clip (caps at {DEFAULT_CONTINUOUS_RECORDER_MAX_FRAMES} frames, then truncates
  honestly); frames whose dimensions stop matching the first recorded frame (an ROI change
  mid-recording) are dropped and counted, and Discard abandons a recording without downloading.
  Energy JSON keeps the last {ENERGY_SAMPLE_CAP} FrameSamples under the current
  tunables — changing a tunable restarts the window. Everything downloads as a file; fixtures
  never touch device storage.
</p>
