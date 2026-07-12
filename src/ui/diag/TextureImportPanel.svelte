<script lang="ts">
  import {
    probeTextureImport,
    type TextureImportProbeReport,
  } from '../../core/gpu/texture-import-probe'
  import type { DiagSession } from './diag-session'
  import Verdict from './Verdict.svelte'
  import { errorText, fmtUs } from './format'

  let { session }: { session: DiagSession } = $props()

  let running = $state(false)
  let report = $state<TextureImportProbeReport | null>(null)
  let probeError = $state<string | null>(null)

  const ready = $derived(session.video !== null && session.device !== null)

  async function run() {
    const video = session.video
    const device = session.device
    if (video === null || device === null || running) return
    running = true
    probeError = null
    report = null
    // A GPU re-acquire or camera restart mid-probe swaps the session's
    // device/video without passing through null; results measured against the
    // destroyed device are contaminated, so they are discarded, not shown.
    const sessionUnchanged = () => session.device === device && session.video === video
    try {
      const result = await probeTextureImport(device, {
        videoElement: video,
        // Constructed-VideoFrame source: built straight from the live video
        // element (no canvas hop), with the required microsecond timestamp.
        createVideoFrame: () =>
          new VideoFrame(video, { timestamp: Math.round(performance.now() * 1000) }),
      })
      if (sessionUnchanged()) report = result
      else probeError = 'GPU device or camera changed mid-probe — results discarded, run again'
    } catch (error) {
      probeError = sessionUnchanged()
        ? errorText(error)
        : 'GPU device or camera changed mid-probe — results discarded, run again'
    } finally {
      running = false
    }
  }
</script>

<div class="controls">
  <button onclick={run} disabled={!ready || running}>
    {running ? 'Probing…' : 'Run texture-import probe'}
  </button>
</div>

{#if !ready}
  <p class="hint">Needs the camera running and a GPU device acquired.</p>
{/if}

{#if probeError !== null}
  <p class="error">Probe threw: {probeError}</p>
{/if}

{#if report !== null}
  <div class="table-scroll">
    <table>
      <thead>
        <tr>
          <th>Path</th>
          <th>Source</th>
          <th>Result</th>
          <th>Frames</th>
          <th>Median cost</th>
          <th>p95 cost</th>
        </tr>
      </thead>
      <tbody>
        {#each report.results as result (result.path + result.source)}
          <tr>
            <td><code>{result.path}</code></td>
            <td>{result.source}</td>
            <td>
              {#if result.ok}
                <Verdict verdict="pass" label="OK" />
              {:else if !result.attempted}
                <Verdict verdict="na" label="SKIPPED" /> {result.error}
              {:else}
                <Verdict verdict="fail" /> {result.error}
              {/if}
            </td>
            <td class="num">{result.framesMeasured ?? '—'}</td>
            <td class="num">{fmtUs(result.medianImportCostUs)}</td>
            <td class="num">{fmtUs(result.p95ImportCostUs)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  <p class="hint">{report.timingNote}</p>
{/if}
