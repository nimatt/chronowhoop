<main>
  <h1>ChronoWhoop</h1>
  <p class="tagline">Tiny-whoop lap timer</p>

  <a class="fly-link" href="#/fly">Fly</a>
  <p class="note">
    Quick session: point the camera at the gate, arm, and hear your lap times. Nothing is saved
    yet — courses and history arrive in a later phase.
  </p>

  <footer class="links">
    <a href="#/diag">diagnostics</a>
    <a href="#/lab">lab</a>
  </footer>
</main>

<style>
  main {
    text-align: center;
    padding-top: 4rem;
  }

  h1 {
    margin-bottom: 0.25rem;
  }

  .tagline {
    opacity: 0.7;
    margin-top: 0;
  }

  .fly-link {
    display: inline-block;
    margin: 2rem 0 0.75rem;
    padding: 1rem 3.5rem;
    border-radius: 0.5rem;
    background: #1d3a6e;
    border: 1px solid #3b5fa3;
    color: #e8edf7;
    font-size: 1.4rem;
    font-weight: 600;
    text-decoration: none;
  }

  .fly-link:hover {
    border-color: #7ea6ff;
  }

  .note {
    max-width: 26rem;
    margin: 0.5rem auto 3rem;
    font-size: 0.9rem;
    opacity: 0.75;
  }

  .links {
    display: flex;
    justify-content: center;
    gap: 1.5rem;
    font-size: 0.85rem;
    opacity: 0.6;
  }
</style>
