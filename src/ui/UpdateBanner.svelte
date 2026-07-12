<script lang="ts">
  import { registerSW } from 'virtual:pwa-register'

  let updateAvailable = $state(false)

  const activateUpdateAndReload = registerSW({
    onNeedRefresh() {
      updateAvailable = true
    },
  })
</script>

{#if updateAvailable}
  <div class="banner" role="status">
    <span>Update available</span>
    <button onclick={() => activateUpdateAndReload(true)}>Update now</button>
  </div>
{/if}

<style>
  .banner {
    position: fixed;
    bottom: 1rem;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 1rem;
    border-radius: 0.5rem;
    background: #1c2740;
    color: #e8edf7;
    border: 1px solid #33436b;
    box-shadow: 0 4px 16px rgb(0 0 0 / 40%);
  }

  button {
    font: inherit;
    padding: 0.35rem 0.75rem;
    border-radius: 0.375rem;
    border: none;
    background: #3d6bff;
    color: white;
    cursor: pointer;
  }
</style>
