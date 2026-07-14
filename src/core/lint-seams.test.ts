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

// The courses.json critical section (plan 09 item 6). CoursesRepo.enqueueWrite
// is the app's only serialization point for a whole-document read-merge-write,
// and a second writer resurrects deleted courses with their sessions already
// destroyed. This was a comment in repos.ts — a comment that Home.svelte
// (storage.importAll) and export-action.ts (storage.exportAll) had ALREADY
// violated while it stood — so it is a seam now, and these tests are what stop
// it rotting back into a comment.
describe('seam/courses-json-critical-section', () => {
  const queuedMembers = [
    'saveCourses',
    'deleteCourse',
    'deleteSession',
    'importAll',
    'exportAll',
    'resumePendingDeletions',
  ]

  // The two static shapes a Storage handle takes in this codebase — and the two
  // that actually shipped as violations.
  const handles = {
    'a bare `storage` binding': (member: string) => `storage.${member}(x)`,
    'a `.storage` property': (member: string) => `context.storage.${member}(x)`,
    'computed access on a `.storage` property': (member: string) =>
      `context.storage['${member}'](x)`,
    'destructuring a `storage` binding': (member: string) => `const { ${member} } = storage`,
  }

  for (const member of queuedMembers) {
    for (const [shape, build] of Object.entries(handles)) {
      test(`UI-file Storage.${member} via ${shape} errors`, async () => {
        await expectSeamError(build(member), 'src/ui/screens/a.ts', 'no-restricted-syntax')
      })
    }
  }

  test('the same calls inside src/ui/data/repos.ts pass (it IS the critical section)', async () => {
    await expectNoSeamError(
      queuedMembers.map((member) => `this.storage.${member}(x)`).join('\n'),
      'src/ui/data/repos.ts',
    )
  })

  // The load-bearing negative case. CoursesRepoView deliberately exposes
  // deleteCourse / importAll / exportAll and SessionsRepoView exposes
  // deleteSession — those are the sanctioned doors, and storage-context.svelte.ts
  // calls resumePendingDeletions on the repo CLASS. Ban the bare method NAMES and
  // every one of these fires: the seam has to discriminate on the handle. (Same
  // lesson as `remove`, rejected from the OPFS list because it would hit
  // `element.remove()`.)
  test('the repository views keep their names — the ban is on the handle, not the method name', async () => {
    await expectNoSeamError(
      [
        'context.coursesRepo.deleteCourse(id)',
        'context.coursesRepo.importAll(envelope)',
        'context.coursesRepo.exportAll()',
        'context.sessionsRepo.deleteSession(id)',
        'coursesRepo.resumePendingDeletions()',
      ].join('\n'),
      'src/ui/screens/a.ts',
    )
  })

  test('a queued call in a .svelte component script errors (the Home.svelte violation)', async () => {
    await expectSeamError(
      '<script lang="ts">\n  void context.storage.importAll(envelope)\n</script>',
      'src/ui/screens/Home.svelte',
      'no-restricted-syntax',
    )
  })

  test('saveSession is NOT queued — the fly path writes session files, not courses.json', async () => {
    await expectNoSeamError('storage.saveSession(session)', 'src/ui/data/storage-context.svelte.ts')
  })

  test('a queued call in a test file passes (tests hold a real Storage on purpose)', async () => {
    await expectNoSeamError('storage.deleteCourse(id)', 'src/ui/screens/a.browser.test.ts')
  })

  test('aliasing the handle is a deliberate, documented gap (not caught)', async () => {
    // Same boundary as the OPFS seam's dynamic-access gap: this is a guardrail
    // against accidental bypass, not an adversarial one. Layer 1 (the import
    // ban below) is what makes the alias hard to obtain in the first place.
    await expectNoSeamError('const s = storage\ns.deleteCourse(id)', 'src/ui/screens/a.ts')
  })
})

// Layer 1 of the same seam: a Storage handle exists in exactly two src/ui files.
// Nothing else may even NAME the type — so re-widening StorageContext back to a
// `readonly storage: Storage` fails at the import line, before there is anything
// to call.
describe('seam/storage-handle-only-in-the-data-layer', () => {
  const importStorage = "import type { Storage } from '../../core/storage/storage'\nexport type X = Storage"

  test('a UI screen naming the Storage type errors', async () => {
    await expectSeamError(importStorage, 'src/ui/screens/a.ts', 'no-restricted-imports')
  })

  test('re-widening StorageContext with a Storage handle errors', async () => {
    // The exact regression this layer exists to catch: the field is what put
    // storage.deleteCourse() one dot away from every screen in the app.
    await expectSeamError(
      "import type { Storage } from '../../core/storage/storage'\nexport interface StorageContext {\n  readonly storage: Storage\n}",
      'src/ui/data/storage-context.ts',
      'no-restricted-imports',
    )
  })

  test('a UI screen constructing an OpfsStorage errors', async () => {
    await expectSeamError(
      "import { OpfsStorage } from '../../core/storage/opfs-storage'\nexport const s = new OpfsStorage({})",
      'src/ui/screens/a.ts',
      'no-restricted-imports',
    )
  })

  test('product code constructing a MemoryStorage errors', async () => {
    await expectSeamError(
      "import { MemoryStorage } from '../../core/storage/memory-storage'\nexport const s = new MemoryStorage()",
      'src/ui/screens/a.svelte.ts',
      'no-restricted-imports',
    )
  })

  test('the two handle holders may name it', async () => {
    await expectNoSeamError(importStorage, 'src/ui/data/repos.ts')
    await expectNoSeamError(importStorage, 'src/ui/data/storage-context.svelte.ts')
  })

  test('the rest of the storage module stays open — only the handle is restricted', async () => {
    // SessionSummary, ImportResult, isStorageError, summarizeSession and friends
    // are ordinary types/helpers the screens read; banning the module wholesale
    // would have been the lazy version of this seam.
    await expectNoSeamError(
      "import { isStorageError, type SessionSummary } from '../../core/storage/storage'\nexport { isStorageError }\nexport type X = SessionSummary",
      'src/ui/screens/a.ts',
    )
  })

  test('the fly path may name the narrowed SessionWriter', async () => {
    await expectNoSeamError(
      "import type { SessionWriter } from '../../core/session/session-persister'\nexport type X = SessionWriter",
      'src/ui/fly/fly-session.svelte.ts',
    )
  })

  test('tests may hold a MemoryStorage', async () => {
    await expectNoSeamError(
      "import { MemoryStorage } from '../../core/storage/memory-storage'\nexport const s = new MemoryStorage()",
      'src/ui/screens/a.browser.test.ts',
    )
  })

  test('src/core is untouched by this seam (the persister and the contract suite hold handles)', async () => {
    await expectNoSeamError(importStorage, 'src/core/session/session-persister.ts')
  })
})
