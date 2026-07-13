<script lang="ts">
  import {
    ANNOTATION_FORMAT_VERSION,
    parseAnnotation,
    serializeAnnotation,
    type ClipCrossing,
    type ClipTier,
    type CrossingDirection,
  } from '../../core/detection/annotation'
  import { decodeClip, type ClipHeader } from '../../core/detection/clip-format'
  import { ClipSource } from '../../core/detection/clip-source'
  import { DetectionPipeline } from '../../core/detection/pipeline'
  import type { LumaFrame } from '../../core/detection/types'
  import { errorText, fmtMs } from '../diag/format'
  import { downloadBlob } from '../shared/download'
  import { drawEnergyTimeline } from '../shared/energy-bars'
  import { maxNormalizedEnergy } from '../shared/energy-math'
  import type { CaptureSession } from '../shared/capture-session'

  let { session }: { session: CaptureSession } = $props()

  let frames = $state.raw<LumaFrame[] | null>(null)
  let header = $state.raw<ClipHeader | null>(null)
  let clipBaseName = $state('annotation')
  let frameIndex = $state(0)
  let crossings = $state<ClipCrossing[]>([])
  let direction = $state<CrossingDirection>('ltr')
  let tier = $state<ClipTier>('must-pass')
  let notes = $state('')
  // Conditions from a loaded sidecar round-trip untouched (not editable here).
  let conditions = $state.raw<Record<string, string> | undefined>(undefined)
  let loadError = $state<string | null>(null)
  let replayNote = $state<string | null>(null)

  let frameCanvas = $state<HTMLCanvasElement | null>(null)
  let timelineCanvas = $state<HTMLCanvasElement | null>(null)

  async function onClipChosen(event: Event) {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return
    loadError = null
    replayNote = null
    try {
      const decoded = decodeClip(new Uint8Array(await file.arrayBuffer()))
      frames = decoded.frames
      header = decoded.header
      clipBaseName = file.name.replace(/\.cwclip$/i, '') || 'annotation'
      frameIndex = 0
      crossings = []
    } catch (error) {
      loadError = errorText(error)
    } finally {
      input.value = ''
    }
  }

  async function onSidecarChosen(event: Event) {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return
    loadError = null
    try {
      const annotation = parseAnnotation(await file.text())
      tier = annotation.tier
      crossings = annotation.crossings
      notes = annotation.notes ?? ''
      conditions = annotation.conditions
    } catch (error) {
      loadError = errorText(error)
    } finally {
      input.value = ''
    }
  }

  // Redraws whenever the loaded clip or the step position changes —
  // user-driven, not per-frame pipeline data.
  $effect(() => {
    const canvas = frameCanvas
    const frame = frames?.[frameIndex]
    if (!canvas || !frame) return
    canvas.width = frame.width
    canvas.height = frame.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const image = ctx.createImageData(frame.width, frame.height)
    for (let i = 0; i < frame.data.length; i++) {
      const luma = frame.data[i]
      image.data[i * 4] = luma
      image.data[i * 4 + 1] = luma
      image.data[i * 4 + 2] = luma
      image.data[i * 4 + 3] = 255
    }
    ctx.putImageData(image, 0, 0)
  })

  function step(delta: number) {
    if (frames === null) return
    frameIndex = Math.min(frames.length - 1, Math.max(0, frameIndex + delta))
  }

  function markCrossing() {
    crossings = [...crossings, { frameIndex, direction }]
  }

  function removeCrossing(index: number) {
    crossings = crossings.filter((_, i) => i !== index)
  }

  function downloadSidecar() {
    loadError = null
    try {
      const sorted = [...crossings].sort((a, b) => a.frameIndex - b.frameIndex)
      const json = serializeAnnotation({
        formatVersion: ANNOTATION_FORMAT_VERSION,
        tier,
        crossings: sorted,
        ...(conditions !== undefined ? { conditions } : {}),
        ...(notes.trim() !== '' ? { notes: notes.trim() } : {}),
      })
      downloadBlob(`${clipBaseName}.json`, json, 'application/json')
    } catch (error) {
      loadError = errorText(error)
    }
  }

  // Offline signal-quality review: replay the loaded clip through a fresh
  // pipeline with the CURRENT lab tunables and plot max normalized strip
  // energy per frame against the trigger line.
  function replayThroughPipeline() {
    if (frames === null) return
    loadError = null
    try {
      const source = new ClipSource(frames)
      const pipeline = new DetectionPipeline(source, session.tunables)
      const maxEnergies: number[] = []
      pipeline.start((sample) => {
        maxEnergies.push(maxNormalizedEnergy(sample.energies, sample.stripPixelCounts))
      })
      source.pumpAll()
      pipeline.stop()
      drawEnergyTimeline(timelineCanvas, maxEnergies, session.tunables.triggerLevel)
      const peak = maxEnergies.reduce((a, b) => Math.max(a, b), 0)
      replayNote =
        `${maxEnergies.length} frames replayed, peak normalized energy ` +
        `${peak.toFixed(3)} vs trigger ${session.tunables.triggerLevel.toFixed(2)}`
    } catch (error) {
      loadError = errorText(error)
    }
  }
</script>

<div class="controls">
  <label class="file">
    Load clip (.cwclip)
    <input type="file" accept=".cwclip" onchange={(e) => void onClipChosen(e)} />
  </label>
  <label class="file">
    Load sidecar (.json)
    <input type="file" accept=".json" onchange={(e) => void onSidecarChosen(e)} />
  </label>
</div>

{#if loadError !== null}
  <p class="error">{loadError}</p>
{/if}

{#if frames === null || header === null}
  <p class="hint">
    Load a recorded .cwclip to step it frame by frame, mark crossing frames + directions, and
    export the annotation sidecar (the clip's ground truth).
  </p>
{:else}
  <p class="clip-info">
    <code>{clipBaseName}.cwclip</code> — {header.width}×{header.height}, {header.frameCount}
    frames
  </p>
  <canvas class="frame" bind:this={frameCanvas}></canvas>
  <div class="controls">
    <button onclick={() => step(-10)} disabled={frameIndex === 0}>−10</button>
    <button onclick={() => step(-1)} disabled={frameIndex === 0}>−1</button>
    <span class="position">
      frame <code>{frameIndex}</code> / {header.frameCount - 1} — capture
      <code>{fmtMs(header.captureTimesMs[frameIndex])}</code>
    </span>
    <button onclick={() => step(1)} disabled={frameIndex >= header.frameCount - 1}>+1</button>
    <button onclick={() => step(10)} disabled={frameIndex >= header.frameCount - 1}>+10</button>
  </div>

  <div class="controls">
    <label>
      direction
      <select bind:value={direction}>
        <option value="ltr">ltr</option>
        <option value="rtl">rtl</option>
      </select>
    </label>
    <button onclick={markCrossing}>Mark crossing here</button>
  </div>

  {#if crossings.length === 0}
    <p class="hint">No crossings marked yet.</p>
  {:else}
    <ul class="crossings">
      {#each crossings as crossing, index (index)}
        <li>
          frame <code>{crossing.frameIndex}</code> — {crossing.direction}
          <button onclick={() => removeCrossing(index)}>remove</button>
        </li>
      {/each}
    </ul>
  {/if}

  <div class="controls">
    <label>
      tier
      <select bind:value={tier}>
        <option value="must-pass">must-pass</option>
        <option value="known-limitation">known-limitation</option>
      </select>
    </label>
    <label class="notes">
      notes
      <input type="text" bind:value={notes} placeholder="conditions, caveats…" />
    </label>
    <button onclick={downloadSidecar}>Download sidecar</button>
  </div>

  <div class="controls">
    <button onclick={replayThroughPipeline}>Replay through pipeline</button>
    {#if replayNote !== null}
      <span class="hint">{replayNote}</span>
    {/if}
  </div>
  <canvas class="timeline" bind:this={timelineCanvas} width="360" height="80"></canvas>
{/if}

<style>
  .file {
    font-size: 0.85rem;
    display: inline-flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .frame {
    display: block;
    width: 100%;
    max-width: 24rem;
    margin: 0.5rem 0;
    border: 1px solid #2c3850;
    border-radius: 0.375rem;
    image-rendering: pixelated;
    background: #000;
  }

  .timeline {
    display: block;
    margin: 0.5rem 0;
    border: 1px solid #2c3850;
    border-radius: 0.375rem;
    max-width: 100%;
  }

  .position {
    font-size: 0.85rem;
  }

  .clip-info {
    font-size: 0.85rem;
    margin: 0.4rem 0;
  }

  .crossings {
    margin: 0.4rem 0;
    padding-left: 1.2rem;
    font-size: 0.85rem;
  }

  .crossings li {
    margin: 0.15rem 0;
  }

  select,
  input[type='text'] {
    background: #16233c;
    color: #e8edf7;
    border: 1px solid #2c3850;
    border-radius: 0.375rem;
    padding: 0.25rem 0.4rem;
    font-size: 0.85rem;
  }

  .notes {
    flex: 1;
    display: inline-flex;
    gap: 0.4rem;
    align-items: center;
  }

  .notes input {
    flex: 1;
  }

  label {
    font-size: 0.85rem;
    display: inline-flex;
    gap: 0.4rem;
    align-items: center;
  }
</style>
