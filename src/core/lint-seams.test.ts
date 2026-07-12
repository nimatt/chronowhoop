import { describe, expect, test } from 'vitest'
import { ESLint } from 'eslint'

// Self-test for the architecture seams enforced by eslint.config.js. Phase 1's
// verification ("a seeded violation fails lint") was a one-shot manual check;
// this makes it permanent, so a widened `ignores`, a typo'd selector, or a
// dropped rule fails CI instead of passing silently.
//
// It runs ESLint programmatically over inline snippets with a `filePath` so the
// path-scoped configs (`src/core/**`, `src/core/storage/**`, `*.test.ts`) apply.
// The instance auto-discovers the repo's flat config from cwd (Vitest's root).

const eslint = new ESLint()

const SEAM_RULES = new Set(['no-restricted-syntax', 'no-restricted-imports'])

async function seamViolations(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath })
  return result.messages
    .filter((message) => message.ruleId !== null && SEAM_RULES.has(message.ruleId))
    .map((message) => message.ruleId as string)
}

async function expectSeamError(code: string, filePath: string, rule: string): Promise<void> {
  expect(await seamViolations(code, filePath), `expected ${rule} for ${filePath}`).toContain(rule)
}

async function expectNoSeamError(code: string, filePath: string): Promise<void> {
  expect(await seamViolations(code, filePath), `expected no seam error for ${filePath}`).toEqual([])
}

describe('seam/core-is-framework-free', () => {
  test('src/core importing svelte errors', async () => {
    await expectSeamError(
      "import { mount } from 'svelte'\nexport const x = mount",
      'src/core/a.ts',
      'no-restricted-imports',
    )
  })

  test('src/core importing a nested svelte subpath errors', async () => {
    // Guards the `svelte/**` pattern: `svelte/*` alone misses `svelte/legacy/*`.
    await expectSeamError(
      "import x from 'svelte/legacy/foo'\nexport const y = x",
      'src/core/a.ts',
      'no-restricted-imports',
    )
  })

  test('src/ui importing svelte is allowed', async () => {
    await expectNoSeamError("import { mount } from 'svelte'\nexport const x = mount", 'src/ui/a.ts')
  })
})

describe('seam/opfs-only-in-core-storage', () => {
  const methods = [
    'getDirectory',
    'getFileHandle',
    'getDirectoryHandle',
    'removeEntry',
    'createWritable',
    'createSyncAccessHandle',
  ]

  const forms = {
    dot: (m: string) => `handle.${m}()`,
    computed: (m: string) => `handle['${m}']()`,
    destructure: (m: string) => `const { ${m} } = handle`,
  }

  for (const method of methods) {
    for (const [formName, build] of Object.entries(forms)) {
      test(`UI-file OPFS ${method} via ${formName} errors`, async () => {
        await expectSeamError(build(method), 'src/ui/a.ts', 'no-restricted-syntax')
      })
    }
  }

  test('same OPFS code inside src/core/storage passes', async () => {
    await expectNoSeamError('handle.getFileHandle(); handle.createSyncAccessHandle()', 'src/core/storage/a.ts')
  })

  test('OPFS code in a unit test file passes', async () => {
    await expectNoSeamError('handle.getDirectory(); handle.createWritable()', 'src/ui/a.test.ts')
  })

  test('OPFS code in a .svelte component script errors (svelte files stay covered)', async () => {
    await expectSeamError(
      '<script lang="ts">\n  void navigator.storage.getDirectory()\n</script>',
      'src/ui/A.svelte',
      'no-restricted-syntax',
    )
  })

  test('OPFS code in a typed .svelte.ts rune module errors (TS parsing is wired up)', async () => {
    // A parse error would surface as a null-ruleId message and the seam rule
    // would be absent, so this also guards the `**/*.svelte.ts` parser config.
    await expectSeamError(
      'const dir: Promise<FileSystemDirectoryHandle> = navigator.storage.getDirectory()\nexport { dir }',
      'src/ui/a.svelte.ts',
      'no-restricted-syntax',
    )
  })

  test('OPFS code in a browser-mode test file passes', async () => {
    await expectNoSeamError('navigator.storage.getDirectory()', 'src/core/storage/a.browser.test.ts')
  })

  test('dynamic property access is a deliberate, documented gap (not caught)', async () => {
    // The seam guards static syntax only; dynamic/reflective access is out of
    // scope by design (see docs/plans/01-foundation.notes.md). This asserts the
    // boundary is intentional so nobody "fixes" it thinking it's a bug.
    await expectNoSeamError("const name = 'getDirectory'\nhandle[name]()", 'src/ui/a.ts')
  })
})

describe('seam/webcodecs-capture-only-in-detection', () => {
  const forms = {
    'new-expression': 'export const p = new MediaStreamTrackProcessor({ track: t })',
    'plain identifier (typeof)': "export const ok = typeof MediaStreamTrackProcessor === 'function'",
    'member access': 'export const ctor = globalThis.MediaStreamTrackProcessor',
    'computed-string access': "export const ctor = globalThis['MediaStreamTrackProcessor']",
    destructure: 'const { MediaStreamTrackProcessor } = globalThis\nexport { MediaStreamTrackProcessor }',
  }

  for (const [formName, code] of Object.entries(forms)) {
    test(`UI-file MediaStreamTrackProcessor via ${formName} errors`, async () => {
      await expectSeamError(code, 'src/ui/a.ts', 'no-restricted-syntax')
    })
  }

  test('same code inside src/core/detection passes', async () => {
    await expectNoSeamError(forms['member access'], 'src/core/detection/a.ts')
  })

  test('same code inside src/core/cpu-pipeline (diag spike) passes', async () => {
    await expectNoSeamError(forms['new-expression'], 'src/core/cpu-pipeline/a.ts')
  })

  test('usage in a unit test file passes', async () => {
    await expectNoSeamError(forms['member access'], 'src/ui/a.test.ts')
  })

  test('usage in src/core/storage errors (the storage override keeps this seam)', async () => {
    // Guards the flat-config override scheme: the storage block replaces the
    // combined rule, so it must re-apply the WebCodecs ban.
    await expectSeamError(forms['member access'], 'src/core/storage/a.ts', 'no-restricted-syntax')
  })

  test('OPFS use in src/core/detection errors (the detection override keeps that seam)', async () => {
    await expectSeamError('handle.getDirectory()', 'src/core/detection/a.ts', 'no-restricted-syntax')
  })
})
