import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import svelte from 'eslint-plugin-svelte'
import globals from 'globals'
import svelteConfig from './svelte.config.js'

// OPFS surface that must stay behind the storage module: the StorageManager
// entry point plus the FileSystem*Handle navigation/IO methods a leaked handle
// would expose. Kept as one table so the seam's scope is reviewable in a glance
// and widening it is a one-line change.
const opfsMethods = [
  'getDirectory',
  'getFileHandle',
  'getDirectoryHandle',
  'removeEntry',
  'createWritable',
  'createSyncAccessHandle',
]

const opfsSeamMessage = (method) =>
  `OPFS access (${method}) is only allowed inside src/core/storage/** — go through the storage module.`

// For each method, catch the three *static* ways to reach it: dot access
// (`x.getDirectory`), computed-string access (`x['getDirectory']`), and
// destructuring (`const { getDirectory } = x`). This is a guardrail against
// accidental direct use and leaked handles — NOT an adversarial boundary.
// Deliberately out of scope (see docs/plans/01-foundation.notes.md): dynamic
// property access via a variable key (`x[name]`), reflective access
// (`Reflect.get`), and re-aliasing/`.call`/`.apply` gymnastics — all require
// intent to evade, which a lint rule cannot meaningfully stop.
const opfsRestrictedSyntax = opfsMethods.flatMap((method) => [
  {
    selector: `MemberExpression[property.name="${method}"]`,
    message: opfsSeamMessage(method),
  },
  {
    selector: `MemberExpression[computed=true][property.value="${method}"]`,
    message: opfsSeamMessage(method),
  },
  {
    selector: `ObjectPattern > Property[key.name="${method}"]`,
    message: opfsSeamMessage(method),
  },
])

// WebCodecs capture surface that must stay behind the detection module (ADR
// 0009): the rest of the app consumes FrameSamples, never the capture API. The
// cpu-pipeline spike (the /diag probes) keeps direct access as a diagnostic
// instrument.
const webCodecsCaptureApis = ['MediaStreamTrackProcessor']

const webCodecsSeamMessage = (api) =>
  `WebCodecs capture (${api}) is only allowed inside src/core/detection/** ` +
  `(and the src/core/cpu-pipeline/** diag spike) — consume FrameSamples from the detection module.`

// A bare Identifier selector catches every static reach for a global
// constructor in one rule: plain use (`typeof MediaStreamTrackProcessor`),
// new-expressions, dot member access (`globalThis.MediaStreamTrackProcessor`),
// and destructuring keys. Computed-string access needs its own selector. Same
// deliberate gaps as the OPFS seam: dynamic/reflective access is out of scope.
const webCodecsRestrictedSyntax = webCodecsCaptureApis.flatMap((api) => [
  {
    selector: `Identifier[name="${api}"]`,
    message: webCodecsSeamMessage(api),
  },
  {
    selector: `MemberExpression[computed=true][property.value="${api}"]`,
    message: webCodecsSeamMessage(api),
  },
])

// Test files may touch either seam's APIs directly: unit (`*.test.ts`) and the
// browser-mode rigs (`*.browser.test.ts`, `*.webgpu.test.ts`) are all
// allowlisted. The browser globs are redundant with `**/*.test.ts` today but
// kept explicit so the allowed surface stays reviewed rather than incidental.
const seamTestFileIgnores = ['**/*.test.ts', '**/*.browser.test.ts', '**/*.webgpu.test.ts']

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...svelte.configs.recommended,
  {
    files: ['src/**'],
    languageOptions: {
      globals: { ...globals.browser, __BUILD_ID__: 'readonly' },
    },
  },
  {
    files: ['*.config.ts', '*.config.js', 'scripts/**', 'eslint.config.js'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: ['.svelte'],
        svelteConfig,
      },
    },
  },
  {
    name: 'seam/core-is-framework-free',
    files: ['src/core/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['svelte', 'svelte/**', '*.svelte', '**/*.svelte'],
              message:
                'src/core is framework-free (CLAUDE.md architecture rules): no svelte imports here.',
            },
          ],
        },
      ],
    },
  },
  // Flat config REPLACES a rule's entry when a later block matches the same
  // file (no merging), so the two seams cannot be independent
  // `no-restricted-syntax` blocks. Instead: one block bans both API surfaces
  // everywhere, and each seam's home directory then re-applies only the OTHER
  // seam's bans. The lint-seams self-test covers the cross cases.
  {
    name: 'seam/opfs-and-webcodecs-restricted',
    files: ['**/*.ts', '**/*.js', '**/*.svelte'],
    ignores: seamTestFileIgnores,
    rules: {
      'no-restricted-syntax': ['error', ...opfsRestrictedSyntax, ...webCodecsRestrictedSyntax],
    },
  },
  {
    name: 'seam/opfs-allowed-in-core-storage',
    files: ['src/core/storage/**'],
    ignores: seamTestFileIgnores,
    rules: {
      'no-restricted-syntax': ['error', ...webCodecsRestrictedSyntax],
    },
  },
  {
    name: 'seam/webcodecs-allowed-in-detection',
    files: ['src/core/detection/**', 'src/core/cpu-pipeline/**'],
    ignores: seamTestFileIgnores,
    rules: {
      'no-restricted-syntax': ['error', ...opfsRestrictedSyntax],
    },
  },
)
