<script lang="ts">
  import { getAudioService } from '../../core/audio/audio-service'
  import { sessionRecords } from '../../core/records/records'
  import Chip from '../shared/Chip.svelte'
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

<!-- Mockup 06 spreads the composition across the full screen: badge row at
     the top, clock + stats centered, Discard/STOP pinned at thumb reach. -->
<div class="armed-screen">
  <div class="armed-top">
    <span class="armed-badge"><span class="pulse"></span>ARMED</span>
  <!-- The Awake chip is the REAL wake-lock state; when the lock is not held,
       WakeLockWarning below carries the warning instead. -->
  {#if session.wakeLockState === 'active'}
    <Chip variant="ok">
      {#snippet icon()}
        <svg class="ic-sm" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="4" />
          <path
            d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19"
          />
        </svg>
      {/snippet}
      Awake
    </Chip>
  {/if}
</div>

{#if session.interruptionNotice}
  <div class="banner notice-warning" role="alert">
    <span>Detection was interrupted — laps during the gap were not detected.</span>
    <button onclick={() => session.dismissInterruption()}>Dismiss</button>
  </div>
{/if}

<WakeLockWarning wakeLockState={session.wakeLockState} />

{#if speechLooksStuck}
  <p class="warn">speech may be stuck — spoken lap times are queuing up</p>
{/if}

<div class="armed-mid">
<div class="clockwrap">
  <div class="clock-label">Current lap</div>
  <div class="clockline">
    <span class="clock" bind:this={clockEl}>· · ·</span>{#if session.clockStarted}<span class="u">
      s</span
    >{/if}
  </div>
  {#if !session.clockStarted}
    <span class="clock-hint">first crossing starts the clock</span>
  {/if}
</div>

<div class="statgrid">
  <div class="s">
    <div class="k">Last lap</div>
    <div class="v" class:discarded={lastLap?.status === 'discarded'}>
      {lastLap === null ? '—' : formatLapSeconds(lastLap.durationMs)}
    </div>
  </div>
  <div class="s best">
    <div class="k">Session best</div>
    <div class="v">{best === undefined ? '—' : formatLapSeconds(best.durationMs)}</div>
  </div>
  <div class="s">
    <div class="k">Laps</div>
    <div class="v">{laps.length}</div>
  </div>
</div>
</div>

<div class="bigbtns">
  <button
    class="btn btn-ghost discard"
    onclick={() => session.discardLastLap()}
    disabled={lastLap === null || lastLap.status === 'discarded'}
  >
    <svg class="ic" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg>
    Discard last lap
  </button>
  <button class="btn btn-danger btn-stop" onclick={() => session.stopSession()}>
    <svg class="stop-ic" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
    STOP
  </button>
</div>
</div>

<style>
  /* Fill the phone viewport (the CourseForm 100dvh pattern; 3rem is main.fly's
     own vertical padding): badge top, clock + stats centered in the slack,
     buttons pinned at the bottom. */
  .armed-screen {
    display: flex;
    flex-direction: column;
    min-height: calc(100dvh - 3rem);
  }

  .armed-mid {
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: center;
  }

  .armed-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin: 0.5rem 0;
  }

  .armed-badge {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-family: var(--font-mono);
    font-size: 0.74rem;
    letter-spacing: 0.22em;
    color: var(--c-signal);
  }

  .pulse {
    width: 11px;
    height: 11px;
    border-radius: 50%;
    background: var(--c-signal);
    box-shadow: 0 0 0 0 rgba(51, 222, 207, 0.6);
    animation: pulse 1.6s ease-out infinite;
  }

  @keyframes pulse {
    0% {
      box-shadow: 0 0 0 0 rgba(51, 222, 207, 0.55);
    }
    70% {
      box-shadow: 0 0 0 12px rgba(51, 222, 207, 0);
    }
    100% {
      box-shadow: 0 0 0 0 rgba(51, 222, 207, 0);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .pulse {
      animation: none;
    }
  }

  .banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    margin: 0.75rem 0;
  }

  .warn {
    font-size: 0.85rem;
    color: var(--c-record);
  }

  .clockwrap {
    text-align: center;
    margin: 1.5rem 0;
  }

  .clock-label {
    font-family: var(--font-mono);
    font-size: 0.7rem;
    letter-spacing: 0.22em;
    text-transform: uppercase;
    color: var(--c-dim);
  }

  .clockline {
    margin-top: 4px;
  }

  .clock {
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    font-size: clamp(4rem, 19vw, 6.1rem);
    line-height: 0.92;
    letter-spacing: -0.03em;
    color: var(--c-ink);
  }

  .u {
    font-family: var(--font-mono);
    font-size: 2rem;
    color: var(--c-dim);
  }

  .clock-hint {
    display: block;
    margin-top: 0.5rem;
    font-size: 0.9rem;
    color: var(--c-dim);
  }

  .statgrid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 10px;
    text-align: center;
    margin: 1rem 0;
  }

  .statgrid .s {
    background: var(--c-panel);
    border: 1px solid var(--c-line);
    border-radius: 13px;
    padding: 12px 6px;
  }

  .statgrid .k {
    font-family: var(--font-mono);
    font-size: 0.58rem;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--c-dim2);
  }

  .statgrid .v {
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    font-size: 1.7rem;
    font-weight: 600;
    margin-top: 4px;
    line-height: 1;
  }

  .statgrid .s.best .v {
    color: var(--c-record);
  }

  .statgrid .v.discarded {
    text-decoration: line-through;
    opacity: 0.6;
  }

  .bigbtns {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-top: 1.5rem;
  }

  .discard {
    padding: 18px;
    font-size: 1.1rem;
  }

  .stop-ic {
    display: block;
    width: 26px;
    height: 26px;
    fill: #1b0407;
  }
</style>
