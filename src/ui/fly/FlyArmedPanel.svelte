<script lang="ts">
  import { getAudioService } from '../../core/audio/audio-service'
  import { sessionRecords } from '../../core/records/records'
  import WakeLockWarning from '../shared/WakeLockWarning.svelte'
  import { formatLapSeconds, formatRunningClock } from './fly-format'
  import type { FlySession } from './fly-session'

  let { session }: { session: FlySession } = $props()

  let clockEl = $state<HTMLSpanElement | null>(null)

  // Speech-health hint: the audio service keeps strong refs to in-flight
  // utterances until their terminal event, and the announcer holds at most
  // one utterance in flight plus one queued — so a pendingUtteranceCount
  // above 1 that persists across polls means the speech engine looks wedged
  // (utterances neither ending nor erroring). 1 Hz poll, reactive only on
  // change.
  const audio = getAudioService()
  let speechLooksStuck = $state(false)
  $effect(() => {
    let previousPending = audio.pendingUtteranceCount
    const timer = setInterval(() => {
      const pending = audio.pendingUtteranceCount
      speechLooksStuck = pending > 1 && previousPending > 1
      previousPending = pending
    }, 1000)
    return () => clearInterval(timer)
  })

  // The running current-lap clock is rAF-driven direct DOM writes, never
  // $state ticks (the bridge rule): it reads the non-reactive clock base each
  // frame — performance.now() recorded when the lap's crossing event arrived
  // (see fly-session.ts ArmedClockBase for the approximation).
  $effect(() => {
    const el = clockEl
    if (el === null) return
    let raf = 0
    const tick = () => {
      const base = session.armedClockBase()
      el.textContent =
        base === null ? '· · ·' : formatRunningClock(performance.now() - base.arrivalPerfMs)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  })

  const laps = $derived(session.laps)
  const lastLap = $derived(laps.length > 0 ? laps[laps.length - 1] : null)
  const best = $derived(sessionRecords(laps).bestLap)
</script>

<div class="armed-badge">ARMED</div>

{#if session.interruptionNotice}
  <div class="banner" role="alert">
    <span>Detection was interrupted — laps during the gap were not detected.</span>
    <button onclick={() => session.dismissInterruption()}>Dismiss</button>
  </div>
{/if}

<WakeLockWarning wakeLockState={session.wakeLockState} />

{#if speechLooksStuck}
  <p class="warn">speech may be stuck — spoken lap times are queuing up</p>
{/if}

<div class="clock-wrap">
  <span class="clock" bind:this={clockEl}>· · ·</span>
  {#if !session.clockStarted}
    <span class="clock-hint">first crossing starts the clock</span>
  {/if}
</div>

<dl class="stats">
  <div>
    <dt>last lap</dt>
    <dd class:discarded={lastLap?.status === 'discarded'}>
      {lastLap === null ? '—' : formatLapSeconds(lastLap.durationMs)}
    </dd>
  </div>
  <div>
    <dt>laps</dt>
    <dd>{laps.length}</dd>
  </div>
  <div>
    <dt>best</dt>
    <dd>{best === undefined ? '—' : formatLapSeconds(best.durationMs)}</dd>
  </div>
</dl>

<div class="controls actions">
  <button class="primary stop" onclick={() => session.stopSession()}>Stop</button>
  <button
    class="discard"
    onclick={() => session.discardLastLap()}
    disabled={lastLap === null || lastLap.status === 'discarded'}
  >
    Discard last lap
  </button>
</div>

<style>
  .armed-badge {
    display: inline-block;
    padding: 0.2rem 0.7rem;
    border-radius: 0.375rem;
    background: #14532d;
    color: #86efac;
    font-weight: 700;
    letter-spacing: 0.15em;
    font-size: 0.85rem;
  }

  .banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    margin: 0.75rem 0;
    padding: 0.6rem 0.8rem;
    border-radius: 0.375rem;
    background: #4a3413;
    border: 1px solid #8a6420;
    color: #ffd27e;
    font-size: 0.95rem;
  }

  .warn {
    font-size: 0.85rem;
    color: #ffd27e;
  }

  .clock-wrap {
    margin: 1.25rem 0;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
  }

  .clock {
    font-size: 5.5rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    line-height: 1;
  }

  .clock-hint {
    margin-top: 0.4rem;
    opacity: 0.7;
    font-size: 0.9rem;
  }

  .stats {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.75rem;
    margin: 1rem 0;
  }

  .stats dt {
    opacity: 0.7;
    font-size: 0.85rem;
  }

  .stats dd {
    margin: 0;
    font-size: 2rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .stats dd.discarded {
    text-decoration: line-through;
    opacity: 0.6;
  }

  .actions {
    margin-top: 1.5rem;
  }

  .actions button {
    min-height: 3.5rem;
    padding: 0.8rem 2rem;
    font-size: 1.2rem;
  }

  .actions .stop {
    background: #7c2b3d;
    border-color: #a63d55;
  }
</style>
