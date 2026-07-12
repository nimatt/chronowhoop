import {
  defaultOpfsStorage,
  type OpfsDirectoryLike,
  type OpfsStorageLike,
  type OpfsWritableLike,
} from './opfs-probe'

export type AtomicWriteScenario = 'abort' | 'never-close' | 'kill-tab'
export type PendingAtomicWriteScenario = Exclude<AtomicWriteScenario, 'abort'>

export const PENDING_ATOMIC_MARKER_FILE = '.chronowhoop-atomic-pending.json'

const ORIGINAL_CONTENT = 'chronowhoop-atomic-original'
const PARTIAL_CONTENT = 'partial'

interface PendingMarker {
  scenario: PendingAtomicWriteScenario
  fileName: string
  expectedContent: string
  startedAtMs: number
}

export type AtomicWriteAbortResult =
  | { ok: false; message: string }
  | { ok: true; contentIntact: boolean; actualContent: string; leftoverArtifacts: string[] }

export type StartPendingAtomicProbeResult =
  | { ok: false; message: string }
  | {
      ok: true
      scenario: PendingAtomicWriteScenario
      fileName: string
      immediateContentIntact: boolean
      immediateLeftoverArtifacts: string[]
    }

export type PendingAtomicProbeCheckResult =
  | { status: 'none' }
  | { status: 'error'; message: string }
  | {
      status: 'completed'
      scenario: PendingAtomicWriteScenario
      contentIntact: boolean
      actualContent: string
      leftoverArtifacts: string[]
      startedAtMs: number
    }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function openRoot(storage: OpfsStorageLike | undefined): Promise<OpfsDirectoryLike> {
  if (typeof storage?.getDirectory !== 'function') {
    throw new Error('navigator.storage.getDirectory is not available')
  }
  return storage.getDirectory()
}

async function writeFileText(
  root: OpfsDirectoryLike,
  name: string,
  content: string,
): Promise<void> {
  const handle = await root.getFileHandle(name, { create: true })
  const writable = await handle.createWritable()
  await writable.write(content)
  await writable.close()
}

async function readFileText(root: OpfsDirectoryLike, name: string): Promise<string> {
  const handle = await root.getFileHandle(name)
  if (typeof handle.getFile !== 'function') {
    throw new Error('FileSystemFileHandle.getFile is not available')
  }
  const file = await handle.getFile()
  return file.text()
}

// Reports files the browser's atomic-write machinery may have left behind
// (Chromium uses `<name>.crswap` staging files). The `.crswap` match is
// intentionally broad so unfamiliar-but-obvious swap leftovers still surface
// on unfamiliar devices.
async function listLeftoverArtifacts(root: OpfsDirectoryLike, fileName: string): Promise<string[]> {
  if (typeof root.keys !== 'function') return []
  const artifacts: string[] = []
  for await (const name of root.keys()) {
    if (name === fileName || name === PENDING_ATOMIC_MARKER_FILE) continue
    if (name.includes(fileName) || name.endsWith('.crswap')) artifacts.push(name)
  }
  return artifacts
}

async function removeOwnArtifacts(
  root: OpfsDirectoryLike,
  fileName: string,
  artifacts: string[],
): Promise<void> {
  for (const name of artifacts) {
    if (name.includes(fileName)) await root.removeEntry(name).catch(() => {})
  }
}

function probeFileName(scenario: AtomicWriteScenario): string {
  return `.chronowhoop-atomic-${scenario}-${Math.random().toString(36).slice(2)}`
}

export async function probeAtomicWriteAbort(
  storage: OpfsStorageLike | undefined = defaultOpfsStorage(),
): Promise<AtomicWriteAbortResult> {
  let root: OpfsDirectoryLike
  try {
    root = await openRoot(storage)
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }

  const fileName = probeFileName('abort')
  try {
    await writeFileText(root, fileName, ORIGINAL_CONTENT)
    const handle = await root.getFileHandle(fileName)
    const writable = await handle.createWritable()
    await writable.write(PARTIAL_CONTENT)
    if (typeof writable.abort !== 'function') {
      return { ok: false, message: 'FileSystemWritableFileStream.abort is not available' }
    }
    await writable.abort()

    const actualContent = await readFileText(root, fileName)
    const leftoverArtifacts = await listLeftoverArtifacts(root, fileName)
    await removeOwnArtifacts(root, fileName, leftoverArtifacts)
    return {
      ok: true,
      contentIntact: actualContent === ORIGINAL_CONTENT,
      actualContent,
      leftoverArtifacts,
    }
  } catch (error) {
    return { ok: false, message: `atomic abort probe failed: ${errorMessage(error)}` }
  } finally {
    await root.removeEntry(fileName).catch(() => {})
  }
}

// The kill-tab scenario needs the writable still un-closed at the moment the
// user kills the tab; retaining it here keeps GC from finalizing the stream
// early. Only one experiment can be pending (starting another overwrites the
// marker), so a superseded experiment's writable is dereferenced — never
// aborted — to release its OPFS lock instead of pinning it for the page
// lifetime. The never-close scenario deliberately drops its writable.
let retainedKillTabWritable: OpfsWritableLike | undefined

export function retainedKillTabWritableForTesting(): OpfsWritableLike | undefined {
  return retainedKillTabWritable
}

export async function startPendingAtomicWriteProbe(
  scenario: PendingAtomicWriteScenario,
  storage: OpfsStorageLike | undefined = defaultOpfsStorage(),
): Promise<StartPendingAtomicProbeResult> {
  let root: OpfsDirectoryLike
  try {
    root = await openRoot(storage)
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }

  const fileName = probeFileName(scenario)
  const marker: PendingMarker = {
    scenario,
    fileName,
    expectedContent: ORIGINAL_CONTENT,
    startedAtMs: Date.now(),
  }

  try {
    await writeFileText(root, fileName, ORIGINAL_CONTENT)
    const handle = await root.getFileHandle(fileName)
    const writable = await handle.createWritable()
    await writable.write(PARTIAL_CONTENT)
    retainedKillTabWritable = scenario === 'kill-tab' ? writable : undefined

    await writeFileText(root, PENDING_ATOMIC_MARKER_FILE, JSON.stringify(marker))

    const actualContent = await readFileText(root, fileName)
    const immediateLeftoverArtifacts = await listLeftoverArtifacts(root, fileName)
    return {
      ok: true,
      scenario,
      fileName,
      immediateContentIntact: actualContent === ORIGINAL_CONTENT,
      immediateLeftoverArtifacts,
    }
  } catch (error) {
    retainedKillTabWritable = undefined
    await root.removeEntry(PENDING_ATOMIC_MARKER_FILE).catch(() => {})
    await root.removeEntry(fileName).catch(() => {})
    return { ok: false, message: `atomic ${scenario} probe failed to start: ${errorMessage(error)}` }
  }
}

function isPendingMarker(value: unknown): value is PendingMarker {
  if (typeof value !== 'object' || value === null) return false
  const marker = value as Partial<PendingMarker>
  return (
    (marker.scenario === 'never-close' || marker.scenario === 'kill-tab') &&
    typeof marker.fileName === 'string' &&
    typeof marker.expectedContent === 'string' &&
    typeof marker.startedAtMs === 'number'
  )
}

export async function checkPendingAtomicProbe(
  storage: OpfsStorageLike | undefined = defaultOpfsStorage(),
): Promise<PendingAtomicProbeCheckResult> {
  let root: OpfsDirectoryLike
  try {
    root = await openRoot(storage)
  } catch (error) {
    return { status: 'error', message: errorMessage(error) }
  }

  let markerText: string
  try {
    markerText = await readFileText(root, PENDING_ATOMIC_MARKER_FILE)
  } catch {
    return { status: 'none' }
  }

  let marker: PendingMarker
  try {
    const parsed: unknown = JSON.parse(markerText)
    if (!isPendingMarker(parsed)) throw new Error('unexpected shape')
    marker = parsed
  } catch (error) {
    await root.removeEntry(PENDING_ATOMIC_MARKER_FILE).catch(() => {})
    return { status: 'error', message: `pending marker unreadable: ${errorMessage(error)}` }
  }

  try {
    const actualContent = await readFileText(root, marker.fileName)
    const leftoverArtifacts = await listLeftoverArtifacts(root, marker.fileName)
    await removeOwnArtifacts(root, marker.fileName, leftoverArtifacts)
    return {
      status: 'completed',
      scenario: marker.scenario,
      contentIntact: actualContent === marker.expectedContent,
      actualContent,
      leftoverArtifacts,
      startedAtMs: marker.startedAtMs,
    }
  } catch (error) {
    return {
      status: 'error',
      message: `pending ${marker.scenario} verification failed: ${errorMessage(error)}`,
    }
  } finally {
    await root.removeEntry(marker.fileName).catch(() => {})
    await root.removeEntry(PENDING_ATOMIC_MARKER_FILE).catch(() => {})
  }
}
