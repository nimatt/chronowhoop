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
    files: ['**/*.svelte'],
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
  {
    name: 'seam/opfs-only-in-core-storage',
    files: ['**/*.ts', '**/*.js', '**/*.svelte'],
    // OPFS APIs live only in the storage module. Test files may touch them
    // directly to exercise real OPFS: unit (`*.test.ts`) and the browser-mode
    // rigs (`*.browser.test.ts`, `*.webgpu.test.ts`) are all allowlisted. The
    // browser globs are redundant with `**/*.test.ts` today but kept explicit
    // so the allowed surface stays reviewed rather than incidental.
    ignores: [
      'src/core/storage/**',
      '**/*.test.ts',
      '**/*.browser.test.ts',
      '**/*.webgpu.test.ts',
    ],
    rules: {
      'no-restricted-syntax': ['error', ...opfsRestrictedSyntax],
    },
  },
)
