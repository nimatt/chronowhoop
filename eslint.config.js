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

// THE COURSES.JSON CRITICAL SECTION (plan 09 item 6). courses.json is a
// whole-document read-merge-write and `CoursesRepo.enqueueWrite` is the app's
// ONLY serialization point for it. Two unsynchronized read-merge-write cycles
// do not merely race: the loser's whole document is overwritten from a stale
// snapshot, which is how a deleted course comes back from the dead with its
// sessions genuinely destroyed. Three separate safety mechanisms — the repo's
// commit counter, its invalidating reload(), and the decision to let the
// deletion journal ride inside AppSettings — all rest on CoursesRepo being the
// only writer of courses.json.
//
// That invariant was a comment in repos.ts, and the comment was ALREADY being
// violated when it was written (Home called storage.importAll, export-action
// called storage.exportAll — both compiled, both linted clean). So it is
// enforced structurally now, in two layers:
//
//   1. THE HANDLE. Exactly two files in src/ui may name a Storage (below).
//      Everything else gets StorageContext's repository views plus a
//      SessionWriter (saveSession only). Re-widening StorageContext back to a
//      `readonly storage: Storage` fails CI at the import line, before anyone
//      even gets to call anything.
//   2. THE CALL. Inside the files that DO hold a handle, the queued members may
//      not be called on it outside repos.ts.
//
// Same deliberate gap as the OPFS seam: this is a guardrail against accidental
// bypass, not an adversarial boundary — an alias (`const s = storage`) or a
// dynamic key evades it, and both require intent.
const storageHandleHolders = ['src/ui/data/repos.ts', 'src/ui/data/storage-context.svelte.ts']

// The Storage members that read-then-write courses.json, or that must not
// observe it half-done. saveSession/loadSession/listSessions are absent on
// purpose: they touch session files only, never the shared document.
const queuedStorageMembers = [
  'saveCourses',
  'deleteCourse',
  'deleteSession',
  'importAll',
  'exportAll',
  'resumePendingDeletions',
]

const criticalSectionMessage = (member) =>
  `Storage.${member} must go through CoursesRepo (src/ui/data/repos.ts) — it is a courses.json ` +
  `read-modify-write and the repo's write queue is the app's only critical section for that ` +
  `document. Calling it directly resurrects deleted courses. Use the coursesRepo/sessionsRepo views.`

// Discriminated by the HANDLE, not by the bare member name: CoursesRepoView
// deliberately exposes deleteCourse / importAll / exportAll and SessionsRepoView
// exposes deleteSession — those are the sanctioned doors and must keep linting
// clean. So the ban targets the two static shapes a Storage handle takes in this
// codebase: a binding named `storage` (`storage.exportAll()`) and a `.storage`
// property (`context.storage.importAll()`, `this.storage.saveCourses()` — the
// two forms that actually shipped as violations).
const criticalSectionRestrictedSyntax = queuedStorageMembers.flatMap((member) => [
  {
    selector: `MemberExpression[object.name="storage"][property.name="${member}"]`,
    message: criticalSectionMessage(member),
  },
  {
    selector: `MemberExpression[object.property.name="storage"][property.name="${member}"]`,
    message: criticalSectionMessage(member),
  },
  {
    selector: `MemberExpression[computed=true][object.name="storage"][property.value="${member}"]`,
    message: criticalSectionMessage(member),
  },
  {
    selector: `MemberExpression[computed=true][object.property.name="storage"][property.value="${member}"]`,
    message: criticalSectionMessage(member),
  },
  {
    selector: `VariableDeclarator[init.name="storage"] > ObjectPattern > Property[key.name="${member}"]`,
    message: criticalSectionMessage(member),
  },
])

// Layer 1: the handle itself. Type-only imports count — a `Storage`-typed prop
// or field is exactly how the handle would spread again.
const storageHandleRestrictedImports = [
  {
    group: ['**/core/storage/storage'],
    importNames: ['Storage'],
    message:
      'The Storage handle lives only in src/ui/data (repos.ts, storage-context.svelte.ts): ' +
      'holding one puts the courses.json critical section (CoursesRepo) one call away from being ' +
      'bypassed. Take a StorageContext and use its repository views; the fly path takes a ' +
      'SessionWriter (core/session/session-persister.ts).',
  },
  {
    group: ['**/core/storage/opfs-storage'],
    importNames: ['OpfsStorage'],
    message:
      'Only src/ui/data/storage-context.svelte.ts constructs a Storage — everything else takes a ' +
      'StorageContext.',
  },
  {
    group: ['**/core/storage/memory-storage'],
    importNames: ['MemoryStorage'],
    message:
      'MemoryStorage is a test double: construct it in tests and inject it through ' +
      'StorageContextOptions.createStorage, never in product code.',
  },
]

// Test files may touch either seam's APIs directly: unit (`*.test.ts`) and the
// browser-mode rig (`*.browser.test.ts`) are allowlisted. The browser glob is
// redundant with `**/*.test.ts` today but kept explicit so the allowed surface
// stays reviewed rather than incidental. Tests are allowed a real Storage
// (MemoryStorage) and a wider handle than product code — a test seam is fine;
// product code is not.
const seamTestFileIgnores = ['**/*.test.ts', '**/*.browser.test.ts']

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
  // Layer 2 of the courses.json seam. src/ui/** does not overlap the two core
  // blocks below, but it DOES overlap the combined block above — and flat
  // config replaces rather than merges — so this block re-applies both API bans
  // alongside the critical-section one. repos.ts is the critical section, so it
  // is exempt (falling back to the combined block, which still bans OPFS and
  // WebCodecs there).
  {
    name: 'seam/courses-json-critical-section',
    files: ['src/ui/**'],
    ignores: [...seamTestFileIgnores, 'src/ui/data/repos.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...opfsRestrictedSyntax,
        ...webCodecsRestrictedSyntax,
        ...criticalSectionRestrictedSyntax,
      ],
    },
  },
  // Layer 1: nothing in src/ui may even NAME a Storage outside the two files
  // that legitimately hold one.
  {
    name: 'seam/storage-handle-only-in-the-data-layer',
    files: ['src/ui/**'],
    ignores: [...seamTestFileIgnores, ...storageHandleHolders],
    rules: {
      'no-restricted-imports': ['error', { patterns: storageHandleRestrictedImports }],
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
