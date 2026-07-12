<script lang="ts">
  import {
    DEFAULT_CAMERA_CONSTRAINTS,
    type CameraErrorKind,
  } from '../../core/camera/camera-service'
  import {
    probeAutoControls,
    type AutoControlApplyAttempt,
    type AutoControlProbeReport,
  } from '../../core/camera/auto-control-probe'
  import type { DiagSession } from './diag-session'
  import Verdict from './Verdict.svelte'
  import { errorText, fmtNumber } from './format'

  let { session }: { session: DiagSession } = $props()

  const cameraState = $derived(session.cameraState)
  let videoElement = $state<HTMLVideoElement | null>(null)
  let startError = $state<string | null>(null)
  let probeReport = $state<AutoControlProbeReport | null>(null)
  let probeError = $state<string | null>(null)
  let probeRunning = $state(false)

  const requested = DEFAULT_CAMERA_CONSTRAINTS.video

  // Both platforms in one line per kind: Android Chrome is the target device,
  // desktop covers the dev machine. 'denied' covers prompt denied, prompt
  // dismissed, blocked in site settings, and blocked by the OS — Chrome's
  // rejection cannot reliably tell these apart (see raw message below).
  const recoveryInstructions: Record<CameraErrorKind, string> = {
    denied:
      'Camera permission was not granted — the prompt was denied or dismissed, or camera access ' +
      'is blocked in site or OS settings. If you dismissed the prompt, press Start camera again ' +
      'and choose Allow. ' +
      'Android Chrome: ⋮ → Settings → Site settings → Camera → allow this site; if the OS blocks ' +
      'Chrome, Settings → Apps → Chrome → Permissions → Camera → Allow. ' +
      'Desktop: lock icon in the address bar → Site settings → Camera → Allow (and enable the ' +
      'camera for your browser in the OS privacy settings), then reload.',
    'insecure-context':
      'Camera requires a secure context. Open the app over HTTPS (or localhost).',
    'no-camera': 'No camera was found on this device.',
    'camera-in-use':
      'The camera is in use by another app. Close it, then press Start camera again.',
    'constraints-unsatisfiable':
      'No camera satisfies the requested constraints. This should not happen with ideal-only constraints; note it in the device matrix.',
    aborted: 'The camera request was aborted. Press Start camera to retry.',
    'getusermedia-unsupported': 'This browser does not expose getUserMedia.',
    unknown: 'Unknown camera failure — see the message below.',
  }

  $effect(() => {
    session.video = videoElement
  })

  $effect(() => {
    if (videoElement !== null && cameraState.status === 'active') {
      videoElement.srcObject = cameraState.stream
    }
  })

  async function startCamera() {
    startError = null
    try {
      await session.camera.start()
    } catch (error) {
      startError = errorText(error)
    }
  }

  function stopCamera() {
    probeReport = null
    probeError = null
    session.camera.stop()
  }

  async function runAutoControlProbe() {
    if (cameraState.status !== 'active') return
    probeRunning = true
    probeError = null
    probeReport = null
    try {
      const track = cameraState.stream.getVideoTracks()[0]
      if (!track) throw new Error('active stream has no video track')
      probeReport = await probeAutoControls(track)
    } catch (error) {
      probeError = errorText(error)
    } finally {
      probeRunning = false
    }
  }

  function attemptText(attempt: AutoControlApplyAttempt): string {
    if (!attempt.attempted) return attempt.error ?? 'not attempted'
    return attempt.ok ? 'ok' : `failed: ${attempt.error ?? 'unknown'}`
  }
</script>

<div class="controls">
  <button
    onclick={startCamera}
    disabled={cameraState.status === 'active' || cameraState.status === 'requesting'}
  >
    Start camera
  </button>
  <button onclick={stopCamera} disabled={cameraState.status === 'idle'}>Stop camera</button>
  <button
    onclick={runAutoControlProbe}
    disabled={cameraState.status !== 'active' || probeRunning}
  >
    {probeRunning ? 'Probing auto-controls…' : 'Probe auto-controls'}
  </button>
  <span class="state">state: <code>{cameraState.status}</code></span>
</div>

{#if startError !== null}
  <p class="error">start() threw: {startError}</p>
{/if}

{#if cameraState.status === 'idle'}
  <p class="hint">Camera idle — press Start camera (requires a permission prompt/gesture).</p>
{:else if cameraState.status === 'requesting'}
  <p class="hint">Requesting camera… answer the permission prompt.</p>
{:else if cameraState.status === 'active'}
  <video bind:this={videoElement} muted playsinline autoplay class="preview"></video>
  <div class="table-scroll">
    <table>
      <thead>
        <tr><th></th><th>Requested (ideal)</th><th>Granted</th></tr>
      </thead>
      <tbody>
        <tr>
          <th>Resolution</th>
          <td class="num">{requested.width.ideal}×{requested.height.ideal}</td>
          <td class="num">{cameraState.granted.width ?? '—'}×{cameraState.granted.height ?? '—'}</td>
        </tr>
        <tr>
          <th>Frame rate</th>
          <td class="num">{requested.frameRate.ideal}</td>
          <td class="num">{fmtNumber(cameraState.granted.frameRate, 1)}</td>
        </tr>
        <tr>
          <th>Facing mode</th>
          <td>{requested.facingMode.ideal}</td>
          <td>{cameraState.granted.facingMode ?? '—'}</td>
        </tr>
        <tr>
          <th>Camera</th>
          <td>—</td>
          <td>{cameraState.granted.label ?? '—'}</td>
        </tr>
      </tbody>
    </table>
  </div>
{:else}
  <p class="error">
    {cameraState.status} ({cameraState.error.kind}): {recoveryInstructions[cameraState.error.kind]}
  </p>
  <p class="hint">Raw message: <code>{cameraState.error.message}</code></p>
{/if}

{#if probeError !== null}
  <p class="error">Auto-control probe failed: {probeError}</p>
{/if}

{#if probeReport !== null}
  <dl class="kv">
    <dt>getCapabilities exposed</dt>
    <dd>
      <Verdict
        verdict={probeReport.capabilitiesExposed ? 'pass' : 'fail'}
        label={probeReport.capabilitiesExposed ? 'YES' : 'NO'}
      />
    </dd>
    {#if probeReport.capabilitiesError}
      <dt>error</dt>
      <dd>{probeReport.capabilitiesError}</dd>
    {/if}
  </dl>
  <div class="table-scroll">
    <table>
      <thead>
        <tr>
          <th>Control</th>
          <th>Advertised modes</th>
          <th>Initial</th>
          <th>Lock (manual)</th>
          <th>After lock</th>
          <th>Settings reflect</th>
          <th>Restore</th>
          <th>After restore</th>
        </tr>
      </thead>
      <tbody>
        {#each probeReport.controls as control (control.control)}
          <tr>
            <td><code>{control.control}</code></td>
            <td>
              {control.advertisedModes === 'not-exposed'
                ? 'not exposed'
                : control.advertisedModes.join(', ')}
            </td>
            <td>{control.initialValue ?? '—'}</td>
            <td>
              {#if control.lock.attempted}
                <Verdict verdict={control.lock.ok ? 'pass' : 'fail'} label={control.lock.ok ? 'OK' : 'FAIL'} />
              {/if}
              {attemptText(control.lock)}
            </td>
            <td>{control.valueAfterLock ?? '—'}</td>
            <td>
              {#if control.settingsReflectLock !== undefined}
                <Verdict
                  verdict={control.settingsReflectLock ? 'pass' : 'fail'}
                  label={control.settingsReflectLock ? 'YES' : 'NO'}
                />
              {:else}
                —
              {/if}
            </td>
            <td>{attemptText(control.restore)}</td>
            <td>{control.valueAfterRestore ?? '—'}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<style>
  .preview {
    width: 100%;
    max-width: 24rem;
    border-radius: 0.375rem;
    background: #000;
    display: block;
    margin: 0.5rem 0;
  }

  .state {
    font-size: 0.85rem;
    opacity: 0.8;
  }
</style>
