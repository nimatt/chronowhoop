<script lang="ts">
  import { observeDeviceLoss, type DeviceLossEvent } from '../../core/gpu/device-loss-observer'
  import type { DiagSession } from './diag-session'
  import Verdict from './Verdict.svelte'
  import { errorText, fmtMs } from './format'

  let { session }: { session: DiagSession } = $props()

  interface LossLogEntry extends DeviceLossEvent {
    generation: number
  }

  let acquiring = $state(false)
  let acquireError = $state<string | null>(null)
  let adapterInfo = $state<[string, string][] | null>(null)
  let lossLog = $state<LossLogEntry[]>([])
  let currentDeviceLost = $state(false)
  let generation = 0

  function readAdapterInfo(adapter: GPUAdapter): [string, string][] {
    const info = adapter.info as GPUAdapterInfo | undefined
    if (!info) return []
    const fields: [string, string | undefined][] = [
      ['vendor', info.vendor],
      ['architecture', info.architecture],
      ['device', info.device],
      ['description', info.description],
    ]
    return fields.filter((entry): entry is [string, string] => !!entry[1])
  }

  async function acquireDevice() {
    acquiring = true
    acquireError = null
    try {
      const gpu = navigator.gpu
      if (!gpu) throw new Error('navigator.gpu is not available')
      const adapter = await gpu.requestAdapter()
      if (!adapter) throw new Error('requestAdapter() returned null')
      adapterInfo = readAdapterInfo(adapter)
      const device = await adapter.requestDevice()
      session.device?.destroy()
      session.device = device
      generation += 1
      currentDeviceLost = false
      // The log accumulates across re-acquires so one on-device session shows
      // every loss (including the destroy of the replaced device), labelled
      // with the device generation it belongs to.
      const observedGeneration = generation
      observeDeviceLoss(device, (event) => {
        lossLog = [...lossLog, { ...event, generation: observedGeneration }]
        if (observedGeneration === generation) currentDeviceLost = true
      })
    } catch (error) {
      acquireError = errorText(error)
    } finally {
      acquiring = false
    }
  }
</script>

<div class="controls">
  <button onclick={acquireDevice} disabled={acquiring}>
    {acquiring ? 'Acquiring…' : session.device === null ? 'Acquire GPU device' : 'Re-acquire GPU device'}
  </button>
  <span class="hint-inline">
    device:
    {#if session.device !== null}
      <Verdict verdict={currentDeviceLost ? 'fail' : 'pass'} label={currentDeviceLost ? 'LOST' : 'ACTIVE'} />
    {:else}
      <code>none</code>
    {/if}
  </span>
</div>

{#if acquireError !== null}
  <p class="error">{acquireError}</p>
{/if}

{#if adapterInfo !== null}
  <dl class="kv">
    {#each adapterInfo as [key, value] (key)}
      <dt>{key}</dt>
      <dd>{value}</dd>
    {:else}
      <dt>adapter info</dt>
      <dd>not exposed</dd>
    {/each}
  </dl>
{/if}

{#if session.device !== null}
  <p class="hint">
    Loss experiment: background the app / lock the screen / run the 5-minute readback sustain,
    then check this log for a loss transition.
  </p>
  {#if lossLog.length > 0}
    <ul class="log">
      {#each lossLog as entry, index (index)}
        <li>{fmtMs(entry.at, 0)} — device #{entry.generation} lost ({entry.reason}): {entry.message}</li>
      {/each}
    </ul>
  {:else}
    <p class="hint">No device loss observed yet.</p>
  {/if}
{/if}

<style>
  .hint-inline {
    font-size: 0.85rem;
    opacity: 0.9;
  }
</style>
