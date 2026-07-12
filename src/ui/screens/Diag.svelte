<script lang="ts">
  import { checkCapabilities, type CapabilityReport } from '../../core/capabilities/capabilities'
  import CapabilityList from '../CapabilityList.svelte'

  let report = $state<CapabilityReport | null>(null)

  async function runProbes() {
    report = null
    report = await checkCapabilities()
  }

  void runProbes()
</script>

<main>
  <h1>Diagnostics</h1>
  <p>Build <code>{__BUILD_ID__}</code></p>
  <section>
    <h2>Capabilities</h2>
    <CapabilityList {report} />
    <button onclick={runProbes}>Re-run probes</button>
  </section>
  <p><a href="#/">Back to app</a></p>
</main>
