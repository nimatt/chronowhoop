export interface OpfsWritableLike {
  write(data: string): Promise<void>
  close(): Promise<void>
}

export interface OpfsFileHandleLike {
  createWritable(): Promise<OpfsWritableLike>
}

export interface OpfsDirectoryLike {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileHandleLike>
  removeEntry(name: string): Promise<void>
}

export interface OpfsStorageLike {
  getDirectory?(): Promise<OpfsDirectoryLike>
}

export type OpfsProbeResult = { ok: true } | { ok: false; message: string }

function defaultStorage(): OpfsStorageLike | undefined {
  const global = globalThis as { navigator?: { storage?: OpfsStorageLike } }
  return global.navigator?.storage
}

function failed(context: string, error: unknown): OpfsProbeResult {
  const message = error instanceof Error ? error.message : String(error)
  return { ok: false, message: `${context}: ${message}` }
}

export async function probeOpfs(
  storage: OpfsStorageLike | undefined = defaultStorage(),
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
