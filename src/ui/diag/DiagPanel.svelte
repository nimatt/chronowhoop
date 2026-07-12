<script lang="ts">
  import type { Snippet } from 'svelte'
  import { errorText } from './format'

  let { title, children }: { title: string; children: Snippet } = $props()
</script>

<section class="panel">
  <h2>{title}</h2>
  <svelte:boundary>
    {@render children()}
    {#snippet failed(error)}
      <p class="boundary-error">Panel crashed: {errorText(error)}</p>
    {/snippet}
  </svelte:boundary>
</section>

<style>
  .panel {
    margin: 1.25rem 0;
    padding: 0.75rem 1rem 1rem;
    border: 1px solid #22304a;
    border-radius: 0.5rem;
    background: #0e1626;
  }

  h2 {
    margin: 0 0 0.75rem;
    font-size: 1.05rem;
  }

  .boundary-error {
    padding: 0.5rem 0.75rem;
    border-radius: 0.375rem;
    background: #3f1520;
    border: 1px solid #7c2b3d;
    color: #ff8aa0;
  }

  /* Shared styling for panel content rendered via the children snippet
     (scoped styles don't reach snippet content, so these are :global under
     the panel's own scope). */
  .panel :global(button) {
    background: #16233c;
    color: #e8edf7;
    border: 1px solid #2c3850;
    border-radius: 0.375rem;
    padding: 0.35rem 0.8rem;
    font-size: 0.9rem;
    cursor: pointer;
  }

  .panel :global(button:hover:not(:disabled)) {
    border-color: #7ea6ff;
  }

  .panel :global(button:disabled) {
    opacity: 0.45;
    cursor: default;
  }

  .panel :global(.controls) {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
    margin: 0.5rem 0;
  }

  .panel :global(table) {
    border-collapse: collapse;
    margin: 0.5rem 0;
    font-size: 0.85rem;
    width: 100%;
  }

  .panel :global(th),
  .panel :global(td) {
    border: 1px solid #22304a;
    padding: 0.25rem 0.5rem;
    text-align: left;
    vertical-align: top;
  }

  .panel :global(th) {
    background: #131e33;
    font-weight: 600;
  }

  .panel :global(td.num) {
    font-family: monospace;
    text-align: right;
    white-space: nowrap;
  }

  .panel :global(.table-scroll) {
    overflow-x: auto;
  }

  .panel :global(.error) {
    padding: 0.4rem 0.6rem;
    border-radius: 0.375rem;
    background: #3f1520;
    border: 1px solid #7c2b3d;
    color: #ff8aa0;
    font-size: 0.85rem;
    overflow-wrap: anywhere;
  }

  .panel :global(.hint) {
    font-size: 0.85rem;
    opacity: 0.75;
    margin: 0.4rem 0;
  }

  .panel :global(.kv) {
    margin: 0.4rem 0;
    font-size: 0.9rem;
  }

  .panel :global(.kv dt) {
    display: inline;
    opacity: 0.7;
  }

  .panel :global(.kv dd) {
    display: inline;
    margin: 0 0.75rem 0 0.3rem;
    font-family: monospace;
  }

  .panel :global(.log) {
    max-height: 12rem;
    overflow-y: auto;
    margin: 0.5rem 0;
    padding: 0.4rem 0.6rem;
    background: #0b1220;
    border: 1px solid #22304a;
    border-radius: 0.375rem;
    font-family: monospace;
    font-size: 0.78rem;
    list-style: none;
  }

  .panel :global(.log li) {
    padding: 0.1rem 0;
    white-space: nowrap;
  }
</style>
