<script lang="ts">
  import type { CapabilityReport } from '../../core/capabilities/capabilities'
  import CapabilityList from '../CapabilityList.svelte'

  let { report }: { report: CapabilityReport } = $props()
</script>

<main>
  <h1>ChronoWhoop can't run in this browser</h1>
  <p>
    ChronoWhoop detects lap gate crossings from your camera feed and speaks lap times aloud. That
    needs WebCodecs camera capture (MediaStreamTrackProcessor), camera access, local file storage
    (OPFS), and speech synthesis — and this browser is missing at least one of them.
  </p>
  <section>
    <h2>Supported browsers</h2>
    <ul>
      <li>Chrome on Android (primary)</li>
      <li>Chrome or another Chromium browser on desktop</li>
      <li>
        Safari 26 or newer on iOS — best-effort; iOS currently lacks WebCodecs camera capture, so
        expect this screen there for now
      </li>
    </ul>
  </section>
  <section>
    <h2>What this browser reported</h2>
    <CapabilityList {report} />
  </section>
  <p><a href="#/diag">Open diagnostics</a></p>
</main>
