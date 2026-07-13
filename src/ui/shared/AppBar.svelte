<script lang="ts">
  import type { Snippet } from 'svelte'

  // Mockup .appbar: title (+ optional mono uppercase subtitle), optional back
  // link, right-side actions slot (typically IconButton children).
  // subtitleHref renders the subtitle as a link (SessionView's course name).
  let {
    title,
    subtitle,
    subtitleTone = 'signal',
    subtitleHref,
    backHref,
    onback,
    actions,
  }: {
    title: string
    subtitle?: string
    subtitleTone?: 'signal' | 'dim'
    subtitleHref?: string
    backHref?: string
    onback?: () => void
    actions?: Snippet
  } = $props()
</script>

<header class="appbar">
  <div class="title">
    {#if onback !== undefined}
      <button class="backbtn" aria-label="Back" onclick={onback}>
        <svg class="ic" viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6" /></svg>
      </button>
    {:else if backHref !== undefined}
      <a class="backbtn" aria-label="Back" href={backHref}>
        <svg class="ic" viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6" /></svg>
      </a>
    {/if}
    {#if subtitle !== undefined}
      <div class="heading">
        <h1>{title}</h1>
        {#if subtitleHref !== undefined}
          <a class="sub" class:dim={subtitleTone === 'dim'} href={subtitleHref}>{subtitle}</a>
        {:else}
          <span class="sub" class:dim={subtitleTone === 'dim'}>{subtitle}</span>
        {/if}
      </div>
    {:else}
      <h1>{title}</h1>
    {/if}
  </div>
  {#if actions}
    <div class="actions">{@render actions()}</div>
  {/if}
</header>

<style>
  .appbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 6px 2px 2px;
  }

  .title {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }

  .heading {
    min-width: 0;
  }

  h1 {
    margin: 0;
    font-size: 1.18rem;
    letter-spacing: -0.01em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .sub {
    font-family: var(--font-mono);
    font-size: 0.66rem;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--c-signal);
  }

  .sub.dim {
    color: var(--c-dim);
  }

  a.sub {
    text-decoration: none;
  }

  a.sub:hover {
    text-decoration: underline;
  }

  .actions {
    display: flex;
    gap: 8px;
    flex: none;
  }

  .backbtn {
    width: 34px;
    height: 34px;
    border-radius: 10px;
    display: grid;
    place-items: center;
    background: var(--c-panel);
    border: 1px solid var(--c-line);
    color: var(--c-ink);
    flex: none;
    cursor: pointer;
  }
</style>
