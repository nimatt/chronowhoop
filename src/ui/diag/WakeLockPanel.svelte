<script lang="ts">
  import { untrack } from 'svelte'
  import {
    createWakeLockService,
    type WakeLockService,
    type WakeLockState,
    type WakeLockTransition,
  } from '../../core/wake-lock/wake-lock'
  import Verdict, { type VerdictKind } from './Verdict.svelte'
  import { errorText, fmtMs } from './format'

  let lockState = $state<WakeLockState>('unsupported')
  let transitions = $state<WakeLockTransition[]>([])
  let actionError = $state<string | null>(null)

  let service: WakeLockService | null = null

  // Created inside the effect body (not component init) so a first-render
  // crash caught by the panel boundary never leaks the service's
  // visibilitychange listener. untrack: the onTransition callback fires
  // synchronously during creation (initial transition) and reads
  // `transitions` — tracked, that read would recreate the service on every
  // later transition.
  $effect(() => {
    const created = untrack(() =>
      createWakeLockService({
        onTransition: (transition) => {
          lockState = transition.state
          transitions = [...transitions, transition]
        },
      }),
    )
    service = created
    return () => {
      service = null
      void created.dispose()
    }
  })

  async function act(action: (service: WakeLockService) => Promise<void>) {
    if (service === null) return
    actionError = null
    try {
      await action(service)
    } catch (error) {
      actionError = errorText(error)
    }
  }

  const stateVerdict: Record<WakeLockState, VerdictKind> = {
    active: 'pass',
    acquiring: 'warn',
    released: 'na',
    failed: 'fail',
    unsupported: 'fail',
  }
</script>

<div class="controls">
  <button onclick={() => void act((s) => s.acquire())} disabled={lockState === 'unsupported'}>
    Acquire
  </button>
  <button onclick={() => void act((s) => s.release())} disabled={lockState === 'unsupported'}>
    Release
  </button>
  <span>
    state: <Verdict verdict={stateVerdict[lockState]} label={lockState.toUpperCase()} />
  </span>
</div>

{#if actionError !== null}
  <p class="error">{actionError}</p>
{/if}

<p class="hint">
  Reacquire experiment: acquire the lock, then lock the screen (or switch tabs) and come back.
  Expect a platform release while hidden and an automatic “reacquire after visibilitychange”
  transition on return.
</p>

<ul class="log">
  {#each transitions as transition, index (index)}
    <li>
      {fmtMs(transition.at, 0)} — {transition.state}
      {transition.releaseSource ? ` (release: ${transition.releaseSource})` : ''}
      {transition.detail ? ` — ${transition.detail}` : ''}
    </li>
  {/each}
</ul>
