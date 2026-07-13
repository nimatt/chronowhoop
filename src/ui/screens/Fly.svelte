<script lang="ts">
  import type { CameraMediaDevicesLike } from '../../core/camera/camera-service'
  import { createFlySession } from '../fly/fly-session.svelte'
  import type { FlySession } from '../fly/fly-session'
  import FlyArmedPanel from '../fly/FlyArmedPanel.svelte'
  import FlySetupPanel from '../fly/FlySetupPanel.svelte'
  import FlyStoppedPanel from '../fly/FlyStoppedPanel.svelte'
  import FlyTestPanel from '../fly/FlyTestPanel.svelte'

  // mediaDevices is the browser test's capture seam; onsession hands the test
  // the created session (for the crossing-injection seam). The real route
  // passes neither.
  let {
    mediaDevices,
    onsession,
  }: {
    mediaDevices?: CameraMediaDevicesLike
    onsession?: (session: FlySession) => void
  } = $props()

  // Created once per mount from the initial prop value — the seam is
  // deliberately not reactive.
  // svelte-ignore state_referenced_locally
  const session = createFlySession({ mediaDevices })
  // svelte-ignore state_referenced_locally
  onsession?.(session)

  $effect(() => () => session.destroy())
</script>

<main class="fly">
  <header>
    <h1>Quick session</h1>
    {#if session.phase === 'setup'}
      <a href="#/">Home</a>
    {/if}
  </header>

  {#if session.phase === 'setup'}
    <FlySetupPanel {session} />
  {:else if session.phase === 'test'}
    <FlyTestPanel {session} />
  {:else if session.phase === 'armed'}
    <FlyArmedPanel {session} />
  {:else}
    <FlyStoppedPanel {session} />
  {/if}
</main>

<style>
  header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: 0.75rem;
  }

  h1 {
    margin: 0;
    font-size: 1.4rem;
  }

  /* Shared styling for the phase panels (scoped styles don't reach child
     components, so these are :global under the screen's own class). */
  .fly :global(button) {
    background: #16233c;
    color: #e8edf7;
    border: 1px solid #2c3850;
    border-radius: 0.375rem;
    padding: 0.4rem 0.9rem;
    font-size: 0.95rem;
    cursor: pointer;
  }

  .fly :global(button:hover:not(:disabled)) {
    border-color: #7ea6ff;
  }

  .fly :global(button:disabled) {
    opacity: 0.45;
    cursor: default;
  }

  .fly :global(button.primary) {
    background: #1d3a6e;
    border-color: #3b5fa3;
    font-weight: 600;
  }

  .fly :global(.controls) {
    display: flex;
    flex-wrap: wrap;
    gap: 0.6rem;
    align-items: center;
    margin: 0.6rem 0;
  }

  .fly :global(.hint) {
    font-size: 0.9rem;
    opacity: 0.75;
    margin: 0.4rem 0;
  }

  .fly :global(.error) {
    padding: 0.5rem 0.7rem;
    border-radius: 0.375rem;
    background: #3f1520;
    border: 1px solid #7c2b3d;
    color: #ff8aa0;
    font-size: 0.9rem;
    overflow-wrap: anywhere;
  }
</style>
