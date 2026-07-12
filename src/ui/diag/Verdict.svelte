<script module lang="ts">
  import type { DiagVerdict } from '../../core/diag/verdicts'

  export type VerdictKind = DiagVerdict
</script>

<script lang="ts">
  let { verdict, label }: { verdict: VerdictKind; label?: string } = $props()

  const defaultLabels: Record<VerdictKind, string> = {
    pass: 'PASS',
    warn: 'DEGRADED',
    fail: 'FAIL',
    na: 'N/A',
  }
</script>

<span class="chip {verdict}">{label ?? defaultLabels[verdict]}</span>

<style>
  .chip {
    display: inline-block;
    padding: 0.05rem 0.45rem;
    border-radius: 0.375rem;
    border: 1px solid transparent;
    font-family: monospace;
    font-weight: bold;
    font-size: 0.75rem;
    white-space: nowrap;
  }

  .pass {
    background: #10381f;
    border-color: #1f6b3a;
    color: #5fd68a;
  }

  .warn {
    background: #3a2c10;
    border-color: #7a5b1f;
    color: #ffd27e;
  }

  .fail {
    background: #3f1520;
    border-color: #7c2b3d;
    color: #ff8aa0;
  }

  .na {
    background: #1a2233;
    border-color: #2c3850;
    color: #9aa7bf;
  }
</style>
