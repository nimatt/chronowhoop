<script lang="ts">
  import {
    getAudioService,
    type SpeechLifecycleEvent,
    type VoiceLike,
  } from '../../core/audio/audio-service'
  import {
    probeCancelThenSpeak,
    probeRapidBackToBackSpeech,
    probeSpeakAfterReturn,
    type SpeechProbeName,
    type SpeechProbeResult,
  } from '../../core/audio/speech-probes'
  import Verdict from './Verdict.svelte'
  import { errorText, fmtMs } from './format'

  const service = getAudioService()

  let primed = $state(service.primed)
  let primeError = $state<string | null>(null)
  let voices = $state<readonly VoiceLike[]>(service.voices)
  let defaultVoice = $state<VoiceLike | null>(service.defaultVoice)
  let pendingCount = $state(service.pendingUtteranceCount)
  let events = $state<(SpeechLifecycleEvent & { logIndex: number })[]>([])
  let nextLogIndex = 0
  let actionError = $state<string | null>(null)
  let runningProbe = $state<SpeechProbeName | null>(null)
  let results = $state<Partial<Record<SpeechProbeName, SpeechProbeResult>>>({})
  let returnProbeArmed = $state(false)
  let sawHidden = $state(false)

  const EVENT_LOG_LIMIT = 50

  // Created inside the effect body (not component init) so a first-render
  // crash caught by the panel boundary never leaks them.
  $effect(() => {
    const unsubscribe = service.onEvent((event) => {
      events = [...events.slice(-(EVENT_LOG_LIMIT - 1)), { ...event, logIndex: nextLogIndex++ }]
      pendingCount = service.pendingUtteranceCount
    })

    // A stuck pendingUtteranceCount with no events is exactly the wedged-engine
    // signature, so it is polled rather than only refreshed on events.
    const pollTimer = setInterval(() => {
      pendingCount = service.pendingUtteranceCount
      voices = service.voices
      defaultVoice = service.defaultVoice
    }, 1000)

    const onVisibilityChange = () => {
      if (returnProbeArmed && document.visibilityState === 'hidden') sawHidden = true
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      unsubscribe()
      clearInterval(pollTimer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  })

  async function prime() {
    primeError = null
    try {
      await service.primeOnGesture()
    } catch (error) {
      primeError = errorText(error)
    }
    primed = service.primed
    voices = service.voices
    defaultVoice = service.defaultVoice
  }

  function guarded(action: () => void) {
    actionError = null
    try {
      action()
    } catch (error) {
      actionError = errorText(error)
    }
  }

  async function runProbe(
    name: SpeechProbeName,
    probe: () => Promise<SpeechProbeResult>,
  ): Promise<void> {
    if (runningProbe !== null) return
    runningProbe = name
    actionError = null
    try {
      const result = await probe()
      results = { ...results, [name]: result }
    } catch (error) {
      actionError = errorText(error)
    } finally {
      runningProbe = null
    }
  }

  function armReturnProbe() {
    returnProbeArmed = true
    sawHidden = false
  }

  function runReturnProbe() {
    returnProbeArmed = false
    void runProbe('speak-after-return', () => probeSpeakAfterReturn(service))
  }

  const probeTitles: Record<SpeechProbeName, string> = {
    'rapid-back-to-back': 'Rapid back-to-back',
    'cancel-then-speak': 'Cancel, then speak',
    'speak-after-return': 'Speak after background/foreground',
  }

  const resultList = $derived(
    (Object.keys(probeTitles) as SpeechProbeName[])
      .map((name) => results[name])
      .filter((result): result is SpeechProbeResult => result !== undefined),
  )

  function voiceLabel(voice: VoiceLike): string {
    const tags = [voice.lang, voice.localService ? 'local' : 'network', voice.default ? 'default' : '']
    return `${voice.name} (${tags.filter(Boolean).join(', ')})`
  }
</script>

<div class="controls">
  <button onclick={prime}>Prime audio</button>
  <Verdict verdict={primed ? 'pass' : 'na'} label={primed ? 'PRIMED' : 'NOT PRIMED'} />
  <button onclick={() => guarded(() => void service.speak('fourteen three'))}>Test voice</button>
  <button onclick={() => guarded(() => service.beep())}>Beep</button>
</div>

{#if primeError !== null}
  <p class="error">Prime failed: {primeError}</p>
{/if}
{#if actionError !== null}
  <p class="error">{actionError}</p>
{/if}

<dl class="kv">
  <dt>default voice</dt>
  <dd>{defaultVoice ? voiceLabel(defaultVoice) : 'none picked'}</dd>
  <dt>pending utterances</dt>
  <dd>{pendingCount}</dd>
</dl>
<details>
  <summary>Voices ({voices.length})</summary>
  <ul class="log">
    {#each voices as voice, index (index)}
      <li>{voiceLabel(voice)}</li>
    {:else}
      <li>no voices reported (yet — voiceschanged may still fire)</li>
    {/each}
  </ul>
</details>

<div class="controls">
  <button
    onclick={() => void runProbe('rapid-back-to-back', () => probeRapidBackToBackSpeech(service))}
    disabled={runningProbe !== null}
  >
    Probe: rapid back-to-back
  </button>
  <button
    onclick={() => void runProbe('cancel-then-speak', () => probeCancelThenSpeak(service))}
    disabled={runningProbe !== null}
  >
    Probe: cancel-then-speak
  </button>
</div>

<div class="return-probe">
  <p class="hint">
    Background/foreground probe: 1. press Arm, 2. background the app (or lock the screen) for at
    least 5 seconds, 3. return here and press Run — no new tap between returning and Run would be
    ideal, but the button press is required to trigger it; judge audibility by ear.
  </p>
  <div class="controls">
    <button onclick={armReturnProbe} disabled={returnProbeArmed}>
      Arm
    </button>
    <button onclick={runReturnProbe} disabled={!returnProbeArmed || runningProbe !== null}>
      Run (after returning)
    </button>
    {#if returnProbeArmed}
      <span class="hint-inline">
        armed — backgrounding {sawHidden ? 'observed' : 'not observed yet'}
      </span>
    {/if}
  </div>
</div>

{#each resultList as result (result.probe)}
  <div class="result">
    <h3>
      {probeTitles[result.probe]}
      <Verdict verdict={result.ok ? 'pass' : 'fail'} label={result.ok ? 'OK' : 'FAIL'} />
    </h3>
    <p class="hint">{result.detail} — total {fmtMs(result.totalMs, 0)}</p>
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Step</th>
            <th>start</th>
            <th>end</th>
            <th>error</th>
            <th>start delay</th>
            <th>duration</th>
            <th>gap from prev end</th>
            <th>timed out</th>
          </tr>
        </thead>
        <tbody>
          {#each result.steps as step (step.label)}
            <tr>
              <td>{step.label} — “{step.text}”</td>
              <td>{step.startFired ? 'yes' : 'no'}</td>
              <td>{step.endFired ? 'yes' : 'no'}</td>
              <td>{step.errorFired ? (step.error ?? 'yes') : 'no'}</td>
              <td class="num">{fmtMs(step.startDelayMs, 0)}</td>
              <td class="num">{fmtMs(step.durationMs, 0)}</td>
              <td class="num">{fmtMs(step.gapFromPreviousEndMs, 0)}</td>
              <td>
                {#if step.timedOut}
                  <Verdict verdict="fail" label="TIMED OUT" />
                {:else}
                  no
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </div>
{/each}

<h3>Lifecycle events (last {EVENT_LOG_LIMIT})</h3>
<ul class="log">
  {#each events as event (event.logIndex)}
    <li>
      {fmtMs(event.timestamp, 0)} — #{event.utteranceId} {event.type}
      “{event.text}”{event.error ? ` (${event.error})` : ''}
    </li>
  {:else}
    <li>no speech activity yet</li>
  {/each}
</ul>

<style>
  h3 {
    margin: 0.75rem 0 0.25rem;
    font-size: 0.95rem;
  }

  details {
    margin: 0.4rem 0;
    font-size: 0.85rem;
  }

  .hint-inline {
    font-size: 0.85rem;
    opacity: 0.8;
  }

  .return-probe {
    margin-top: 0.5rem;
    border-top: 1px solid #22304a;
  }
</style>
