<script lang="ts">
  import { DEFAULT_DETECTION_TUNABLES } from '../../core/detection/types'
  import { fmtNumber } from '../diag/format'
  import type { CaptureSession } from '../shared/capture-session'

  let { session }: { session: CaptureSession } = $props()

  const tunables = $derived(session.tunables)

  function numberValue(event: Event): number {
    return Number((event.currentTarget as HTMLInputElement).value)
  }

  function resetDefaults() {
    const { stripCount, threshold, emaTimeConstantMs, triggerLevel } = DEFAULT_DETECTION_TUNABLES
    session.updateTunables({ stripCount, threshold, emaTimeConstantMs, triggerLevel })
  }
</script>

<div class="sliders">
  <label>
    <span>strip count</span>
    <input
      type="range"
      min="2"
      max="32"
      step="1"
      value={tunables.stripCount}
      oninput={(e) => session.updateTunables({ stripCount: numberValue(e) })}
    />
    <code>{tunables.stripCount}</code>
  </label>
  <label>
    <span>diff threshold</span>
    <input
      type="range"
      min="0"
      max="255"
      step="1"
      value={tunables.threshold}
      oninput={(e) => session.updateTunables({ threshold: numberValue(e) })}
    />
    <code>{tunables.threshold}</code>
  </label>
  <label>
    <span>EMA τ (ms)</span>
    <input
      type="range"
      min="50"
      max="2000"
      step="5"
      value={Math.round(tunables.emaTimeConstantMs)}
      oninput={(e) => session.updateTunables({ emaTimeConstantMs: numberValue(e) })}
    />
    <code>{fmtNumber(tunables.emaTimeConstantMs, 0)}</code>
  </label>
  <label>
    <span>trigger level</span>
    <!-- min matches CrossingDetector's validator (triggerLevel > 0): 0 would
         throw when test mode feeds the detector. -->
    <input
      type="range"
      min="0.01"
      max="1"
      step="0.01"
      value={tunables.triggerLevel}
      oninput={(e) => session.updateTunables({ triggerLevel: numberValue(e) })}
    />
    <code>{fmtNumber(tunables.triggerLevel, 2)}</code>
  </label>
</div>

<div class="controls">
  <button onclick={resetDefaults}>Reset to defaults</button>
</div>

<p class="hint">
  Applied live to the running pipeline (next frame). The trigger level is a normalized strip
  energy (hot count / strip pixels) — the line in the bars view; Phase 4's state machine consumes
  it.
</p>

<style>
  .sliders {
    display: grid;
    gap: 0.4rem;
    margin: 0.5rem 0;
  }

  label {
    display: grid;
    grid-template-columns: 8rem 1fr 4rem;
    align-items: center;
    gap: 0.6rem;
    font-size: 0.85rem;
  }

  input[type='range'] {
    width: 100%;
  }

  code {
    text-align: right;
  }
</style>
