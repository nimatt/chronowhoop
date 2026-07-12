import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import svelte from 'eslint-plugin-svelte'
import globals from 'globals'
import svelteConfig from './svelte.config.js'

const opfsRestrictedSyntax = [
  {
    selector: 'MemberExpression[property.name="getDirectory"]',
    message:
      'OPFS access (getDirectory) is only allowed inside src/core/storage/** — go through the storage module.',
  },
  {
    selector: 'MemberExpression[property.name="createWritable"]',
    message:
      'OPFS access (createWritable) is only allowed inside src/core/storage/** — go through the storage module.',
  },
  {
    selector: 'MemberExpression[computed=true][property.value="getDirectory"]',
    message:
      'OPFS access (getDirectory) is only allowed inside src/core/storage/** — go through the storage module.',
  },
  {
    selector: 'MemberExpression[computed=true][property.value="createWritable"]',
    message:
      'OPFS access (createWritable) is only allowed inside src/core/storage/** — go through the storage module.',
  },
]

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...svelte.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.browser, __BUILD_ID__: 'readonly' },
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
              group: ['svelte', 'svelte/*', '*.svelte', '**/*.svelte'],
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
