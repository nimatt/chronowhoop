<script lang="ts">
  import type { CameraMediaDevicesLike } from '../../core/camera/camera-service'
  import DiagPanel from '../diag/DiagPanel.svelte'
  import AnnotationPanel from '../lab/AnnotationPanel.svelte'
  import { createLabSession } from '../lab/lab-session.svelte'
  import LivePipelinePanel from '../lab/LivePipelinePanel.svelte'
  import RecorderPanel from '../lab/RecorderPanel.svelte'
  import SelfTestPanel from '../lab/SelfTestPanel.svelte'
  import TestModePanel from '../lab/TestModePanel.svelte'
  import TunablesPanel from '../lab/TunablesPanel.svelte'

  // mediaDevices is the browser test's capture seam (a canvas captureStream
  // behind a fake getUserMedia); the real route passes nothing.
  let { mediaDevices }: { mediaDevices?: CameraMediaDevicesLike } = $props()

  // The session is created once per mount from the initial prop value — the
  // seam is deliberately not reactive.
  // svelte-ignore state_referenced_locally
  const session = createLabSession({ mediaDevices })

  $effect(() => () => session.destroy())
</script>

<main>
  <h1>Lab</h1>
  <p class="note">
    Detection pipeline lab — a debug surface (plans 03–04), not a product screen. Live reduction,
    crossing test mode, fixture capture, annotation, and the deployed-bundle self-test. Build
    <code>{__BUILD_ID__}</code>.
  </p>

  <DiagPanel title="Live pipeline">
    <LivePipelinePanel {session} />
  </DiagPanel>

  <DiagPanel title="Tunables">
    <TunablesPanel {session} />
  </DiagPanel>

  <DiagPanel title="Test mode">
    <TestModePanel {session} />
  </DiagPanel>

  <DiagPanel title="Recorder">
    <RecorderPanel {session} />
  </DiagPanel>

  <DiagPanel title="Annotation stepper">
    <AnnotationPanel {session} />
  </DiagPanel>

  <DiagPanel title="Self-test">
    <SelfTestPanel />
  </DiagPanel>

  <p><a href="#/">Back to app</a></p>
</main>

<style>
  .note {
    font-size: 0.9rem;
    opacity: 0.8;
  }
</style>
