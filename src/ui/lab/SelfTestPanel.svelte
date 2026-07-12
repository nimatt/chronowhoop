<script lang="ts">
  import clipUrl from '../../../fixtures/clips/synthetic-crossing-64x36.cwclip?url'
  import expectedEnergyJson from '../../../fixtures/energies/synthetic-crossing-64x36.energy.json?raw'
  import Verdict from '../diag/Verdict.svelte'
  import { errorText } from '../diag/format'
  import { runSelfTest, type SelfTestReport } from './self-test'

  let report = $state<SelfTestReport | null>(null)
  let failure = $state<string | null>(null)
  let running = $state(false)

  async function run() {
    running = true
    report = null
    failure = null
    try {
      const response = await fetch(clipUrl)
      if (!response.ok) {
        throw new Error(`fetching bundled fixture clip failed: HTTP ${response.status}`)
      }
      const clipBytes = new Uint8Array(await response.arrayBuffer())
      report = runSelfTest(clipBytes, expectedEnergyJson)
    } catch (error) {
      failure = errorText(error)
    } finally {
      running = false
    }
  }

  // Pure fetch + compute, no gesture needed — runs on mount like the /diag
  // capability probes.
  void run()
</script>

<p class="hint">
  Runs the bundled fixture clip through the reducer with DEFAULT tunables and compares every
  frame's strip energies against the committed CI-regenerated energy JSON — the deployed bundle
  proving it computes what CI computed.
</p>

<div class="controls">
  <button onclick={() => void run()} disabled={running}>
    {running ? 'Running…' : 'Re-run self-test'}
  </button>
  {#if report !== null}
    <Verdict verdict={report.pass ? 'pass' : 'fail'} />
    <span class="summary">
      {report.pass ? `${report.frameCount} frames bit-exact` : 'fixture divergence'}
    </span>
  {/if}
</div>

{#if failure !== null}
  <p class="error">Self-test could not run: {failure}</p>
{/if}

{#if report !== null && !report.pass}
  {#if report.detail !== undefined}
    <p class="error">{report.detail}</p>
  {/if}
  {#if report.divergence !== undefined}
    <p class="error">
      first divergence at frame {report.divergence.frameIndex} ({report.divergence.field}):
      expected <code>{report.divergence.expected}</code>, got
      <code>{report.divergence.actual}</code>
    </p>
  {/if}
{/if}

<style>
  .summary {
    font-size: 0.85rem;
  }
</style>
