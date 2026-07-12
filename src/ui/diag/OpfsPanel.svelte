<script lang="ts">
  import {
    checkPendingAtomicProbe,
    probeAtomicWriteAbort,
    startPendingAtomicWriteProbe,
    type AtomicWriteAbortResult,
    type PendingAtomicProbeCheckResult,
    type PendingAtomicWriteScenario,
    type StartPendingAtomicProbeResult,
  } from '../../core/storage/atomic-write-probe'
  import {
    probeOpfs,
    probeStoragePersistence,
    type OpfsProbeResult,
    type StoragePersistenceReport,
  } from '../../core/storage/opfs-probe'
  import { detectDisplayMode } from '../../core/display-mode'
  import Verdict from './Verdict.svelte'
  import { errorText, fmtBytes } from './format'

  const displayMode = detectDisplayMode()

  let pendingCheck = $state<PendingAtomicProbeCheckResult | null>(null)
  let roundTrip = $state<OpfsProbeResult | null>(null)
  let persistence = $state<StoragePersistenceReport | null>(null)
  let abortResult = $state<AtomicWriteAbortResult | null>(null)
  let pendingStart = $state<StartPendingAtomicProbeResult | null>(null)
  let startedScenario = $state<PendingAtomicWriteScenario | null>(null)
  let busy = $state<string | null>(null)
  let panelError = $state<string | null>(null)

  // The pending-probe check is the read-only follow-up half of a previously
  // started experiment (it cleans its own marker) — the one OPFS thing that
  // must run without a button press.
  void checkPendingAtomicProbe().then(
    (result) => (pendingCheck = result),
    (error: unknown) => (pendingCheck = { status: 'error', message: errorText(error) }),
  )

  async function run(name: string, action: () => Promise<unknown>) {
    if (busy !== null) return
    busy = name
    panelError = null
    try {
      await action()
    } catch (error) {
      panelError = errorText(error)
    } finally {
      busy = null
    }
  }

  const scenarioInstructions: Record<PendingAtomicWriteScenario, string> = {
    'never-close':
      'Partial write is open and will never be closed. Now reload the page and revisit /diag — the pending-probe result renders at the top of this panel.',
    'kill-tab':
      'Partial write is open and retained. Now kill the tab/app from the app switcher, reopen the app, and revisit /diag — the pending-probe result renders at the top of this panel.',
  }

  async function startPending(scenario: PendingAtomicWriteScenario) {
    await run(scenario, async () => {
      pendingStart = await startPendingAtomicWriteProbe(scenario)
      startedScenario = pendingStart.ok ? scenario : null
    })
  }

  function intactVerdict(intact: boolean) {
    return intact ? ('pass' as const) : ('fail' as const)
  }
</script>

<dl class="kv">
  <dt>display-mode</dt>
  <dd>{displayMode}</dd>
</dl>

<h3>Pending atomic-write experiment (checked on load)</h3>
{#if pendingCheck === null}
  <p class="hint">Checking for a pending experiment…</p>
{:else if pendingCheck.status === 'none'}
  <p class="hint">No pending atomic-write experiment.</p>
{:else if pendingCheck.status === 'error'}
  <p class="error">{pendingCheck.message}</p>
{:else}
  <dl class="kv">
    <dt>scenario</dt>
    <dd>{pendingCheck.scenario}</dd>
    <dt>original content intact</dt>
    <dd><Verdict verdict={intactVerdict(pendingCheck.contentIntact)} label={pendingCheck.contentIntact ? 'INTACT' : 'CORRUPTED'} /></dd>
    <dt>actual content</dt>
    <dd>“{pendingCheck.actualContent}”</dd>
    <dt>leftover artifacts</dt>
    <dd>{pendingCheck.leftoverArtifacts.length > 0 ? pendingCheck.leftoverArtifacts.join(', ') : 'none'}</dd>
    <dt>started</dt>
    <dd>{new Date(pendingCheck.startedAtMs).toLocaleString()}</dd>
  </dl>
{/if}

{#if panelError !== null}
  <p class="error">{panelError}</p>
{/if}

<div class="controls">
  <button onclick={() => void run('round-trip', async () => (roundTrip = await probeOpfs()))} disabled={busy !== null}>
    Write round-trip
  </button>
  <button
    onclick={() => void run('persistence', async () => (persistence = await probeStoragePersistence()))}
    disabled={busy !== null}
  >
    Persistence report
  </button>
  <button
    onclick={() => void run('abort', async () => (abortResult = await probeAtomicWriteAbort()))}
    disabled={busy !== null}
  >
    Abort atomicity
  </button>
  <button onclick={() => void startPending('never-close')} disabled={busy !== null}>
    Start never-close probe
  </button>
  <button onclick={() => void startPending('kill-tab')} disabled={busy !== null}>
    Start kill-tab probe
  </button>
</div>

{#if roundTrip !== null}
  <dl class="kv">
    <dt>write round-trip</dt>
    <dd>
      <Verdict verdict={roundTrip.ok ? 'pass' : 'fail'} />
      {#if !roundTrip.ok}{roundTrip.message}{/if}
    </dd>
  </dl>
{/if}

{#if persistence !== null}
  <dl class="kv">
    <dt>persisted initially</dt>
    <dd>{persistence.persistedInitially ?? 'unavailable'}</dd>
    <dt>persist() granted</dt>
    <dd>
      {#if persistence.persistGranted !== null}
        <Verdict verdict={persistence.persistGranted ? 'pass' : 'fail'} label={persistence.persistGranted ? 'GRANTED' : 'NOT GRANTED'} />
      {:else}
        unavailable
      {/if}
    </dd>
    <dt>quota</dt>
    <dd>{fmtBytes(persistence.quotaBytes)}</dd>
    <dt>usage</dt>
    <dd>{fmtBytes(persistence.usageBytes)}</dd>
    {#if persistence.detail}
      <dt>notes</dt>
      <dd>{persistence.detail}</dd>
    {/if}
  </dl>
  <p class="hint">Note: this probe calls navigator.storage.persist() for real — the origin may now be persisted.</p>
{/if}

{#if abortResult !== null}
  {#if abortResult.ok}
    <dl class="kv">
      <dt>abort atomicity</dt>
      <dd>
        <Verdict verdict={intactVerdict(abortResult.contentIntact)} label={abortResult.contentIntact ? 'INTACT' : 'CORRUPTED'} />
        content after abort: “{abortResult.actualContent}”, artifacts:
        {abortResult.leftoverArtifacts.length > 0 ? abortResult.leftoverArtifacts.join(', ') : 'none'}
      </dd>
    </dl>
  {:else}
    <p class="error">Abort probe: {abortResult.message}</p>
  {/if}
{/if}

{#if pendingStart !== null}
  {#if pendingStart.ok && startedScenario !== null}
    <dl class="kv">
      <dt>{pendingStart.scenario} probe started</dt>
      <dd>
        file {pendingStart.fileName}, content currently
        {pendingStart.immediateContentIntact ? 'intact' : 'already changed'}, immediate artifacts:
        {pendingStart.immediateLeftoverArtifacts.length > 0
          ? pendingStart.immediateLeftoverArtifacts.join(', ')
          : 'none'}
      </dd>
    </dl>
    <p class="hint">{scenarioInstructions[startedScenario]}</p>
  {:else if !pendingStart.ok}
    <p class="error">Pending probe failed to start: {pendingStart.message}</p>
  {/if}
{/if}

<style>
  h3 {
    margin: 0.75rem 0 0.25rem;
    font-size: 0.95rem;
  }
</style>
