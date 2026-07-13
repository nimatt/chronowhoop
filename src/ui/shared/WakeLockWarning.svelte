<script lang="ts">
  import type { WakeLockState } from '../../core/wake-lock/wake-lock'

  // product.md: the wake lock covers the whole camera-active flow, so every
  // camera-active screen surfaces the same soft warning when it isn't held.
  let { wakeLockState }: { wakeLockState: WakeLockState } = $props()
</script>

{#if wakeLockState === 'failed' || wakeLockState === 'unsupported'}
  <p class="warn">screen may sleep (wake lock {wakeLockState})</p>
{/if}

<style>
  .warn {
    margin: 0.4rem 0;
    font-size: 0.85rem;
    color: var(--c-record);
  }
</style>
