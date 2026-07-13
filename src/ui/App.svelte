<script lang="ts">
  import { checkCapabilities, type CapabilityReport } from '../core/capabilities/capabilities'
  import { routeFromHash, shouldShowUnsupportedScreen } from '../core/routing/route'
  import { createStorageContext, type StorageContextOptions } from './data/storage-context.svelte'
  import CourseForm from './screens/CourseForm.svelte'
  import CourseView from './screens/CourseView.svelte'
  import Home from './screens/Home.svelte'
  import Diag from './screens/Diag.svelte'
  import Fly from './screens/Fly.svelte'
  import Lab from './screens/Lab.svelte'
  import SessionView from './screens/SessionView.svelte'
  import Unsupported from './screens/Unsupported.svelte'
  import UpdateBanner from './UpdateBanner.svelte'

  let {
    check = checkCapabilities,
    createStorage,
  }: {
    check?: () => Promise<CapabilityReport>
    createStorage?: StorageContextOptions['createStorage']
  } = $props()

  let route = $state(routeFromHash(location.hash))
  let report = $state<CapabilityReport | null>(null)

  // One context per App mount, passed to the storage-backed screens as a prop
  // (the diag/fly session precedent). The seam is deliberately not reactive.
  // svelte-ignore state_referenced_locally
  const context = createStorageContext(createStorage ? { createStorage } : {})
  $effect(() => () => context.destroy())

  // svelte-ignore state_referenced_locally
  void check().then((result) => {
    report = result
  })
</script>

<svelte:window onhashchange={() => (route = routeFromHash(location.hash))} />

{#each context.quarantineNotices as notice (notice.id)}
  <div class="quarantine notice-warning" role="alert">
    <span>
      A stored file was corrupt and set aside{notice.quarantinedTo
        ? ` as ${notice.quarantinedTo}`
        : ''}: {notice.fileName}
    </span>
    <button onclick={() => context.dismissQuarantineNotice(notice.id)}>Dismiss</button>
  </div>
{/each}

{#if report !== null && shouldShowUnsupportedScreen(report.ok, route)}
  <Unsupported {report} />
{:else if route.id === 'diag'}
  <Diag />
{:else if route.id === 'lab'}
  <Lab />
{:else if report === null}
  <p class="checking">Checking browser capabilities…</p>
{:else if route.id === 'fly'}
  <!-- Keyed: Fly resolves its course and prefill once per mount. -->
  {#key route.courseId}
    <Fly {context} courseId={route.courseId} />
  {/key}
{:else if route.id === 'session'}
  {#key route.sessionId}
    <SessionView {context} sessionId={route.sessionId} />
  {/key}
{:else if route.id === 'new-course'}
  <CourseForm {context} />
{:else if route.id === 'edit-course'}
  <!-- Keyed: CourseForm seeds its fields once per mount, so a direct
       edit-A → edit-B navigation must remount, not reuse. -->
  {#key route.courseId}
    <CourseForm {context} courseId={route.courseId} />
  {/key}
{:else if route.id === 'course'}
  <!-- Keyed: CourseView loads its session bodies once per mount, so a direct
       course-A → course-B hash edit must remount, not reuse. -->
  {#key route.courseId}
    <CourseView {context} courseId={route.courseId} />
  {/key}
{:else}
  <Home {context} />
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

  /* Shared notice boxes: every screen's storage-error / warning message uses
     these (screens add layout — margins, flex — locally when needed). */
  :global(.notice-error) {
    padding: 0.5rem 0.7rem;
    border-radius: 0.375rem;
    background: #3f1520;
    border: 1px solid #7c2b3d;
    color: #ff8aa0;
    font-size: 0.9rem;
    overflow-wrap: anywhere;
  }

  :global(.notice-warning) {
    padding: 0.5rem 0.7rem;
    border-radius: 0.375rem;
    background: #3f2d15;
    border: 1px solid #7c5b2b;
    color: #ffcf8a;
    font-size: 0.9rem;
    overflow-wrap: anywhere;
  }

  .checking {
    padding: 1.5rem 1rem;
    text-align: center;
    opacity: 0.7;
  }

  .quarantine {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    max-width: 40rem;
    margin: 0.5rem auto 0;
  }

  .quarantine button {
    flex-shrink: 0;
    background: transparent;
    color: inherit;
    border: 1px solid #7c5b2b;
    border-radius: 0.375rem;
    padding: 0.25rem 0.6rem;
    cursor: pointer;
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
