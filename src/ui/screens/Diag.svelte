<script lang="ts">
  import { checkCapabilities, type CapabilityReport } from '../../core/capabilities/capabilities'
  import CapabilityList from '../CapabilityList.svelte'
  import { createDiagSession } from '../diag/diag-session.svelte'
  import DiagPanel from '../diag/DiagPanel.svelte'
  import CameraPanel from '../diag/CameraPanel.svelte'
  import FrameLoopPanel from '../diag/FrameLoopPanel.svelte'
  import GpuPanel from '../diag/GpuPanel.svelte'
  import TextureImportPanel from '../diag/TextureImportPanel.svelte'
  import ReadbackPanel from '../diag/ReadbackPanel.svelte'
  import CpuPipelinePanel from '../diag/CpuPipelinePanel.svelte'
  import WebCodecsPanel from '../diag/WebCodecsPanel.svelte'
  import SpeechPanel from '../diag/SpeechPanel.svelte'
  import OpfsPanel from '../diag/OpfsPanel.svelte'
  import WakeLockPanel from '../diag/WakeLockPanel.svelte'

  let report = $state<CapabilityReport | null>(null)
  let latestRun = 0

  async function runProbes() {
    const runId = ++latestRun
    report = null
    const result = await checkCapabilities()
    if (runId === latestRun) {
      report = result
    }
  }

  void runProbes()

  const session = createDiagSession()

  $effect(() => () => session.destroy())
</script>

<main>
  <h1>Diagnostics</h1>
  <p>Build <code>{__BUILD_ID__}</code></p>
  <section>
    <h2>Capabilities</h2>
    <CapabilityList {report} />
    <button onclick={runProbes}>Re-run probes</button>
  </section>

  <DiagPanel title="Camera">
    <CameraPanel {session} />
  </DiagPanel>

  <DiagPanel title="Frame loop">
    <FrameLoopPanel {session} />
  </DiagPanel>

  <DiagPanel title="GPU device">
    <GpuPanel {session} />
  </DiagPanel>

  <DiagPanel title="Texture import">
    <TextureImportPanel {session} />
  </DiagPanel>

  <DiagPanel title="Readback benchmark">
    <ReadbackPanel {session} />
  </DiagPanel>

  <DiagPanel title="CPU pipeline">
    <CpuPipelinePanel {session} />
  </DiagPanel>

  <DiagPanel title="CPU pipeline (WebCodecs)">
    <WebCodecsPanel {session} />
  </DiagPanel>

  <DiagPanel title="Speech">
    <SpeechPanel />
  </DiagPanel>

  <DiagPanel title="Storage (OPFS)">
    <OpfsPanel />
  </DiagPanel>

  <DiagPanel title="Wake lock">
    <WakeLockPanel />
  </DiagPanel>

  <p><a href="#/">Back to app</a></p>
</main>
