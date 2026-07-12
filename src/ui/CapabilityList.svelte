<script lang="ts">
  import type { CapabilityReport } from '../core/capabilities/capabilities'

  let { report }: { report: CapabilityReport | null } = $props()
</script>

{#if report === null}
  <p>Running capability probes…</p>
{:else}
  <ul class="capabilities">
    {#each report.capabilities as capability (capability.name)}
      <li class={capability.ok ? 'pass' : 'fail'}>
        <span class="status">{capability.ok ? 'PASS' : 'FAIL'}</span>
        <span class="label">{capability.label}</span>
        {#if capability.detail}
          <span class="detail">{capability.detail}</span>
        {/if}
      </li>
    {/each}
  </ul>
{/if}

<style>
  .capabilities {
    list-style: none;
    padding: 0;
    margin: 1rem 0;
    display: grid;
    gap: 0.5rem;
  }

  li {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    border-radius: 0.375rem;
    border: 1px solid transparent;
  }

  li.pass {
    background: #10381f;
    border-color: #1f6b3a;
  }

  li.fail {
    background: #3f1520;
    border-color: #7c2b3d;
  }

  .status {
    font-family: monospace;
    font-weight: bold;
  }

  li.pass .status {
    color: #5fd68a;
  }

  li.fail .status {
    color: #ff8aa0;
  }

  .detail {
    flex-basis: 100%;
    font-size: 0.85rem;
    opacity: 0.8;
  }
</style>
