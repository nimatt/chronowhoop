export interface OpfsWritableLike {
  write(data: string): Promise<void>
  close(): Promise<void>
  abort?(): Promise<void>
}

export interface OpfsFileLike {
  text(): Promise<string>
}

export interface OpfsFileHandleLike {
  createWritable(): Promise<OpfsWritableLike>
  getFile?(): Promise<OpfsFileLike>
}

export interface OpfsDirectoryLike {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileHandleLike>
  getDirectoryHandle?(name: string, options?: { create?: boolean }): Promise<OpfsDirectoryLike>
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>
  // Structural because lib.dom's FileSystemDirectoryHandle may lack async
  // iteration depending on the enabled libs.
  keys?(): AsyncIterable<string>
}

export interface OpfsStorageLike {
  getDirectory?(): Promise<OpfsDirectoryLike>
  persisted?(): Promise<boolean>
  persist?(): Promise<boolean>
  estimate?(): Promise<{ quota?: number; usage?: number }>
}

export type OpfsProbeResult = { ok: true } | { ok: false; message: string }

export function defaultOpfsStorage(): OpfsStorageLike | undefined {
  const global = globalThis as { navigator?: { storage?: OpfsStorageLike } }
  return global.navigator?.storage
}

function failed(context: string, error: unknown): OpfsProbeResult {
  const message = error instanceof Error ? error.message : String(error)
  return { ok: false, message: `${context}: ${message}` }
}

export async function probeOpfs(
  storage: OpfsStorageLike | undefined = defaultOpfsStorage(),
): Promise<OpfsProbeResult> {
  if (typeof storage?.getDirectory !== 'function') {
    return {
      ok: false,
      message: 'navigator.storage.getDirectory is not available',
    }
  }

  let root: OpfsDirectoryLike
  try {
    root = await storage.getDirectory()
  } catch (error) {
    return failed('getDirectory() failed', error)
  }

  const probeFileName = `.chronowhoop-opfs-probe-${Math.random().toString(36).slice(2)}`
  try {
    const file = await root.getFileHandle(probeFileName, { create: true })
    const writable = await file.createWritable()
    await writable.write('opfs-probe')
    await writable.close()
    return { ok: true }
  } catch (error) {
    return failed('OPFS write probe failed', error)
  } finally {
    await root.removeEntry(probeFileName).catch(() => {})
  }
}

export interface StoragePersistenceReport {
  // null = the API is unavailable or threw; `detail` says which.
  persistedInitially: boolean | null
  persistGranted: boolean | null
  quotaBytes: number | null
  usageBytes: number | null
  detail?: string
}

// Calls navigator.storage.persist() for real (not just persisted()): the
// product will want persistent storage, so the grant answer is the measurement
// that matters. Side effect: the origin may end up persisted after this probe.
export async function probeStoragePersistence(
  storage: OpfsStorageLike | undefined = defaultOpfsStorage(),
): Promise<StoragePersistenceReport> {
  const notes: string[] = []
  const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

  let persistedInitially: boolean | null = null
  if (typeof storage?.persisted === 'function') {
    try {
      persistedInitially = await storage.persisted()
    } catch (error) {
      notes.push(`persisted() failed: ${errorMessage(error)}`)
    }
  } else {
    notes.push('persisted() is not available')
  }

  let persistGranted: boolean | null = null
  if (typeof storage?.persist === 'function') {
    try {
      persistGranted = await storage.persist()
    } catch (error) {
      notes.push(`persist() failed: ${errorMessage(error)}`)
    }
  } else {
    notes.push('persist() is not available')
  }

  let quotaBytes: number | null = null
  let usageBytes: number | null = null
  if (typeof storage?.estimate === 'function') {
    try {
      const estimate = await storage.estimate()
      quotaBytes = estimate.quota ?? null
      usageBytes = estimate.usage ?? null
    } catch (error) {
      notes.push(`estimate() failed: ${errorMessage(error)}`)
    }
  } else {
    notes.push('estimate() is not available')
  }

  return {
    persistedInitially,
    persistGranted,
    quotaBytes,
    usageBytes,
    ...(notes.length > 0 ? { detail: notes.join('; ') } : {}),
  }
}
