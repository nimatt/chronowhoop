<script lang="ts">
  import { untrack } from 'svelte'
  import { checkCapabilities, type CapabilityReport } from '../core/capabilities/capabilities'
  import { routeFromHash, shouldShowUnsupportedScreen } from '../core/routing/route'
  import Home from './screens/Home.svelte'
  import Diag from './screens/Diag.svelte'
  import Lab from './screens/Lab.svelte'
  import Unsupported from './screens/Unsupported.svelte'
  import UpdateBanner from './UpdateBanner.svelte'

  let { check = checkCapabilities }: { check?: () => Promise<CapabilityReport> } = $props()

  let route = $state(routeFromHash(location.hash))
  let report = $state<CapabilityReport | null>(null)

  void untrack(() => check()).then((result) => {
    report = result
  })
</script>

<svelte:window onhashchange={() => (route = routeFromHash(location.hash))} />

{#if report !== null && shouldShowUnsupportedScreen(report.ok, route)}
  <Unsupported {report} />
{:else if route === 'diag'}
  <Diag />
{:else if route === 'lab'}
  <Lab />
{:else if report === null}
  <p class="checking">Checking browser capabilities…</p>
{:else}
  <Home />
{/if}

<UpdateBanner />

<footer>build {__BUILD_ID__}</footer>

<style>
  :global(body) {
    margin: 0;
    min-height: 100vh;
    background: #0b1220;
    color: #e8edf7;
    font-family: system-ui, sans-serif;
  }

  :global(main) {
    max-width: 40rem;
    margin: 0 auto;
    padding: 1.5rem 1rem 4rem;
  }

  :global(a) {
    color: #7ea6ff;
  }

  .checking {
    padding: 1.5rem 1rem;
    text-align: center;
    opacity: 0.7;
  }

  footer {
    position: fixed;
    bottom: 0.25rem;
    right: 0.5rem;
    font-family: monospace;
    font-size: 0.7rem;
    opacity: 0.4;
  }
</style>
