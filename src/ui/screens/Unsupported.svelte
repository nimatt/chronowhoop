<script lang="ts">
  import type {
    CapabilityName,
    CapabilityReport,
    CapabilityResult,
  } from '../../core/capabilities/capabilities'
  import { hashFor } from '../../core/routing/route'

  let { report }: { report: CapabilityReport } = $props()

  // Mockup screen 11 probe rows: short name + dim mono descriptor. The
  // mockup's "WebGPU" row predates ADR 0009 — the detection capability is
  // WebCodecs capture now. CapabilityList (diag) keeps the full report labels;
  // this screen owns its own compact rendering.
  const probeText: Record<CapabilityName, { title: string; descriptor: string }> = {
    webcodecs: { title: 'WebCodecs', descriptor: 'detection capture' },
    camera: { title: 'Camera', descriptor: 'getUserMedia · rear' },
    opfs: { title: 'Local storage', descriptor: 'OPFS · sessions' },
    speech: { title: 'Speech', descriptor: 'lap announcements' },
  }

  function probeRow(capability: CapabilityResult): { title: string; descriptor: string } {
    return probeText[capability.name]
  }
</script>

<main class="unsup">
  <div class="warnmark">
    <svg class="ic big" viewBox="0 0 24 24"><path d="M12 3l9 16H3z" /><path d="M12 10v4M12 17h.01" /></svg>
  </div>
  <div>
    <h2>This browser can't run ChronoWhoop</h2>
    <p class="lead">The timer needs a few web platform features that aren't all available here.</p>
  </div>

  <div class="stack probes">
    {#each report.capabilities as capability (capability.name)}
      <div class="probe" class:pass={capability.ok} class:fail={!capability.ok}>
        <div class="pn">
          <div class="t">{probeRow(capability).title}</div>
          <div class="d">{probeRow(capability).descriptor}</div>
          {#if !capability.ok && capability.detail !== undefined}
            <div class="d detail">{capability.detail}</div>
          {/if}
        </div>
        <div class="st">
          {#if capability.ok}
            <svg class="ic-sm" viewBox="0 0 24 24"><path d="M5 12l4 4L19 6" /></svg>
          {:else}
            <svg class="ic-sm" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg>
          {/if}
        </div>
      </div>
    {/each}
  </div>

  <div class="guide">
    WebCodecs capture powers the motion detector. Open ChronoWhoop in <b>Chrome on Android</b> or
    <b>desktop Chromium</b>. iOS Safari currently lacks the required capture API.
  </div>

  <p class="hint"><a href={hashFor({ id: 'diag' })}>Open diagnostics</a></p>
</main>

<style>
  .unsup {
    display: flex;
    flex-direction: column;
    gap: 18px;
    max-width: 26rem;
  }

  .warnmark {
    width: 58px;
    height: 58px;
    border-radius: 16px;
    display: grid;
    place-items: center;
    color: var(--c-danger);
    border: 1.5px solid rgba(255, 82, 101, 0.5);
    background: rgba(255, 82, 101, 0.08);
  }

  .warnmark .big {
    width: 28px;
    height: 28px;
  }

  h2 {
    margin: 0;
    font-size: 1.3rem;
    letter-spacing: -0.01em;
    line-height: 1.25;
  }

  .lead {
    color: var(--c-dim);
    font-size: 0.92rem;
    line-height: 1.5;
    margin: 8px 0 0;
  }

  .probes {
    gap: 10px;
  }

  .probe {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 13px 14px;
    border: 1px solid var(--c-line);
    border-radius: 12px;
    background: var(--c-panel);
  }

  .pn {
    flex: 1;
    min-width: 0;
  }

  .pn .t {
    font-weight: 600;
    font-size: 0.95rem;
  }

  .pn .d {
    font-size: 0.74rem;
    color: var(--c-dim);
    font-family: var(--font-mono);
  }

  .pn .detail {
    color: var(--c-danger);
    overflow-wrap: anywhere;
  }

  .st {
    width: 26px;
    height: 26px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    flex: none;
  }

  .probe.pass .st {
    color: var(--c-signal);
    background: rgba(51, 222, 207, 0.12);
  }

  .probe.fail {
    border-color: rgba(255, 82, 101, 0.4);
  }

  .probe.fail .st {
    color: var(--c-danger);
    background: rgba(255, 82, 101, 0.12);
  }

  .guide {
    background: rgba(51, 222, 207, 0.06);
    border: 1px solid var(--c-signal-dim);
    border-radius: 12px;
    padding: 14px;
    font-size: 0.86rem;
    line-height: 1.5;
    color: var(--c-ink);
  }

  .guide b {
    color: var(--c-signal);
  }

  .hint {
    margin: 0;
  }
</style>
