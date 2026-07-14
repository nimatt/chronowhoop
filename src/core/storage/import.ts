// Shared import logic (plan 07 item 2, docs/specs/storage.md): parse an
// export file into a validated envelope, compute the pure merge-by-id plan,
// and execute it — both Storage implementations delegate here so their merge
// semantics can never drift. Merge rules (orchestrator decisions, 07 notes):
// unknown ids added, existing ids skipped, local settings always win
// (imported settings fully ignored), orphan sessions imported anyway,
// courses applied before sessions.

import type { Course, Session } from '../domain/types'
import { pendingDeletionsTouchedBy, withoutPendingDeletions } from './delete'
import {
  parseExportEnvelope,
  SchemaVersionError,
  type ExportEnvelope,
} from './schema'
import {
  StorageError,
  type CoursesData,
  type ImportResult,
  type SessionSummary,
} from './storage'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// Raw import-file text → validated ExportEnvelope (migrated to the current
// schema on the way). Every failure is a StorageError, never anything else:
// - schemaVersion newer than this app, or unreachable by any migration chain:
//   'unsupported-version' — the file is fine, the app is too old.
// - malformed JSON or failed validation: 'corrupt', carrying the
//   SchemaError's $-rooted path to the offending field.
export function parseImportFile(text: string): ExportEnvelope {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch (error) {
    throw new StorageError('corrupt', `import file is not valid JSON: ${errorMessage(error)}`, {
      cause: error,
    })
  }
  try {
    return parseExportEnvelope(doc)
  } catch (error) {
    if (error instanceof SchemaVersionError) {
      throw new StorageError(
        'unsupported-version',
        `import file was written by a newer version of this app — update the app, then import again (${error.message})`,
        { cause: error },
      )
    }
    throw new StorageError('corrupt', `import file failed validation: ${errorMessage(error)}`, {
      cause: error,
    })
  }
}

export interface ImportPlan {
  coursesToAdd: Course[]
  sessionsToAdd: Session[]
  result: ImportResult
}

// Ids already stored are skipped; so are later duplicates of an id that
// appears twice inside one envelope (first occurrence wins) — the counts then
// always match what actually lands, and re-import stays idempotent.
function mergeById<T extends { id: string }>(
  items: T[],
  existingIds: ReadonlySet<string>,
): { toAdd: T[]; skipped: number } {
  const seen = new Set(existingIds)
  const toAdd: T[] = []
  for (const item of items) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    toAdd.push(item)
  }
  return { toAdd, skipped: items.length - toAdd.length }
}

// Pure merge-by-id: what an import of `envelope` into a store holding the
// given ids would add, and the add/skip counts reported to the user. Local
// settings are never part of the plan (they always win), and orphan sessions
// (courseId matching no course) are added like any other — dropping data a
// user explicitly imported would be worse than a placeholder course label.
export function computeImportPlan(
  envelope: ExportEnvelope,
  existingCourseIds: ReadonlySet<string>,
  existingSessionIds: ReadonlySet<string>,
): ImportPlan {
  const courses = mergeById(envelope.courses, existingCourseIds)
  const sessions = mergeById(envelope.sessions, existingSessionIds)
  return {
    coursesToAdd: courses.toAdd,
    sessionsToAdd: sessions.toAdd,
    result: {
      coursesAdded: courses.toAdd.length,
      coursesSkipped: courses.skipped,
      sessionsAdded: sessions.toAdd.length,
      sessionsSkipped: sessions.skipped,
    },
  }
}

// The subset of Storage that executing an import needs; implementations pass
// themselves.
export interface ImportTarget {
  loadCourses(): Promise<CoursesData>
  listSessions(): Promise<SessionSummary[]>
  saveCourses(data: CoursesData): Promise<void>
  saveSession(session: Session): Promise<void>
}

// Executes the merge plan: courses first — a single saveCourses carrying the
// merged course list and the EXISTING local settings — then one saveSession
// per new session, so a session can never land before a course it references.
// A mid-import write failure aborts with that write's StorageError and the
// counts so far are lost; recovery is re-importing the same file, which
// merge-by-id makes idempotent (already-landed items are skipped). When the
// plan adds nothing AND no pending deletion is abandoned, nothing is written.
//
// The abandonment (pendingDeletionsTouchedBy, delete.ts) rides in the SAME
// courses write, ahead of every session write, so an import that dies half-way
// still cannot leave a marker that would replay a cascade over what it just
// restored — and it happens even when the plan adds no course at all, which is
// the common restore case: an interrupted cascade keeps the course present
// (the INTENT write says so), so re-importing the backup adds only sessions.
export async function importIntoStorage(
  target: ImportTarget,
  envelope: ExportEnvelope,
): Promise<ImportResult> {
  const existing = await target.loadCourses()
  const summaries = await target.listSessions()
  const envelopeCourseIds = new Set(envelope.courses.map((course) => course.id))
  const envelopeSessionIds = new Set(envelope.sessions.map((session) => session.id))
  const plan = computeImportPlan(
    envelope,
    new Set(existing.courses.map((course) => course.id)),
    new Set(summaries.map((summary) => summary.id)),
  )
  const abandonedDeletions = pendingDeletionsTouchedBy(
    existing,
    envelopeCourseIds,
    envelopeSessionIds,
  )
  if (plan.coursesToAdd.length > 0 || abandonedDeletions.length > 0) {
    await target.saveCourses(
      withoutPendingDeletions(
        { courses: [...existing.courses, ...plan.coursesToAdd], settings: existing.settings },
        abandonedDeletions,
      ),
    )
  }
  for (const session of plan.sessionsToAdd) {
    await target.saveSession(session)
  }
  return plan.result
}
