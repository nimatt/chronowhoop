// In-memory Storage implementation — the workhorse for unit, component, and
// E2E tests (plan 06 item 2). Deep-copies on the way in AND out, so callers
// can never mutate stored state through a retained reference (the OPFS
// implementation gets the same isolation for free from JSON round-trips; the
// contract suite pins it for both).

import type { IsoDateString, Session } from '../domain/types'
import { defaultAppSettings, SCHEMA_VERSION, type ExportEnvelope } from './schema'
import {
  compareSessionRecency,
  StorageError,
  summarizeSession,
  type CoursesData,
  type ImportResult,
  type PersistenceStatus,
  type SessionSummary,
  type Storage,
} from './storage'

export interface MemoryStorageOptions {
  // Clock for ExportEnvelope.exportedAt.
  now?: () => IsoDateString
}

export class MemoryStorage implements Storage {
  private courses: CoursesData | undefined
  private readonly sessions = new Map<string, Session>()
  private readonly now: () => IsoDateString

  constructor(options: MemoryStorageOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString())
  }

  loadCourses(): Promise<CoursesData> {
    return Promise.resolve(
      this.courses ? structuredClone(this.courses) : { courses: [], settings: defaultAppSettings() },
    )
  }

  saveCourses(data: CoursesData): Promise<void> {
    this.courses = structuredClone(data)
    return Promise.resolve()
  }

  listSessions(): Promise<SessionSummary[]> {
    const summaries = [...this.sessions.values()]
      .sort((a, b) => compareSessionRecency(b, a))
      .map(summarizeSession)
    return Promise.resolve(summaries)
  }

  loadSession(id: string): Promise<Session> {
    const session = this.sessions.get(id)
    if (!session) {
      return Promise.reject(new StorageError('not-found', `session "${id}" does not exist`))
    }
    return Promise.resolve(structuredClone(session))
  }

  saveSession(session: Session): Promise<void> {
    this.sessions.set(session.id, structuredClone(session))
    return Promise.resolve()
  }

  latestSessionForCourse(courseId: string): Promise<Session | undefined> {
    let latest: Session | undefined
    for (const session of this.sessions.values()) {
      if (session.courseId !== courseId) continue
      if (!latest || compareSessionRecency(session, latest) > 0) latest = session
    }
    return Promise.resolve(latest && structuredClone(latest))
  }

  async exportAll(): Promise<ExportEnvelope> {
    const { courses, settings } = await this.loadCourses()
    const sessions = [...this.sessions.values()]
      .sort(compareSessionRecency)
      .map((session) => structuredClone(session))
    return { schemaVersion: SCHEMA_VERSION, exportedAt: this.now(), courses, settings, sessions }
  }

  importAll(): Promise<ImportResult> {
    return Promise.reject(new Error('importAll is not implemented until Phase 7'))
  }

  persistenceStatus(): Promise<PersistenceStatus> {
    return Promise.resolve({ persisted: true })
  }
}
