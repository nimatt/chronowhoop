// The file-layer schema contract (docs/specs/storage.md, plan 06 item 1):
// `schemaVersion` envelopes around the frozen Phase 4/5 domain shapes, runtime
// validators for every read path (disk content is never trusted), and the
// vN→vN+1 migration registry applied on read. Writers always write
// SCHEMA_VERSION. The Storage interface itself (storage.ts) trades in domain
// shapes only — envelopes stay inside the file layer.
//
// Validator posture: strict on required fields and types (plus ranges where
// the semantics demand them — durations ≥ 0, dates parseable), tolerant of
// unknown extra keys so a newer minor writer doesn't brick an older reader.
// Parsed results are freshly built objects containing only the known fields;
// unknown keys are ignored, not preserved (any additive schema change bumps
// the one global schemaVersion, so this drops nothing a v1 app should keep).

import type {
  Course,
  IsoDateString,
  Lap,
  Session,
  SessionDetectionConfig,
} from '../domain/types'
import type { CrossingDirection } from '../detection/crossing-events'
import type { DetectionTunables, NormalizedRect } from '../detection/types'
import type { CrossingDetectorConfig } from '../detection/crossing-detector'

// One global schema version shared by courses.json, session files, and the
// export envelope (plan 06 item 1 decision; documented in storage.md).
export const SCHEMA_VERSION = 1

// A course deletion recorded in courses.json before its session files are
// removed, so a cascade interrupted by a crash can finish (or abandon itself)
// on the next launch instead of leaving a course whose session count lies.
export interface PendingCourseDeletion {
  courseId: string
  // Captured while the course entry is still present, so a resume can name the
  // course in its notice without depending on the course still existing.
  courseName: string
  // THE BOUNDED WORK LIST: exactly the sessions the user saw counted and
  // confirmed. A resume may delete these ids and nothing else. Re-deriving the
  // set at resume time (filtering live sessions by courseId) would turn an
  // abandoned deletion into an unbounded standing instruction: fail a delete,
  // walk away, fly the course for another month, and the next launch destroys
  // sessions that did not exist when the confirmation was given.
  sessionIds: string[]
}

// App-level settings stored in courses.json (storage.md). Minimal on purpose.
export interface AppSettings {
  speechEnabled: boolean
  lastExportAt?: IsoDateString
  lastCourseId?: string
  // Absent when nothing is pending. An added optional key needs no
  // SCHEMA_VERSION bump: it is forward-compatible on read, and an older app
  // drops it on its next write, degrading to the un-marked partial state.
  pendingCourseDeletions?: PendingCourseDeletion[]
}

export function defaultAppSettings(): AppSettings {
  return { speechEnabled: true }
}

export interface CoursesFile {
  schemaVersion: number
  courses: Course[]
  settings: AppSettings
}

// Flat, matching storage.md's session example: schemaVersion sits alongside
// the session fields.
export interface SessionFile extends Session {
  schemaVersion: number
}

export interface ExportEnvelope {
  schemaVersion: number
  exportedAt: IsoDateString
  courses: Course[]
  settings: AppSettings
  sessions: Session[]
}

// Raised by validators and the migration driver. `message` always starts with
// a `$`-rooted path to the offending field.
export class SchemaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SchemaError'
  }
}

// The document is structurally intact but this app cannot read its version:
// written by a newer app (schemaVersion > current), or no migration chain
// reaches it. Distinguished from SchemaError because the file layer must
// REFUSE these in place — quarantining would destroy data a newer (or fixed)
// app could still read, e.g. after a version rollback.
export class SchemaVersionError extends SchemaError {
  constructor(message: string) {
    super(message)
    this.name = 'SchemaVersionError'
  }
}

export type SchemaDocument = Record<string, unknown>
export type DocumentKind = 'courses' | 'session' | 'export'

// vN→vN+1 shape transforms, keyed by the version they migrate FROM. Each
// receives the whole document plus which kind it is (one global version, three
// file kinds). The driver stamps the new schemaVersion after each step, so
// migrations only transform shape.
//
// v0 never shipped: SCHEMA_VERSION was 1 from the first byte ever written.
// The 0→1 entry (a fabricated difference — "v0 lacked settings") exists so the
// migration mechanism is proven by tests before it is ever needed (plan 06
// item 1).
export const migrations: Record<number, (doc: SchemaDocument, kind: DocumentKind) => SchemaDocument> = {
  0: (doc, kind) => (kind === 'session' ? doc : { settings: defaultAppSettings(), ...doc }),
}

function describeValue(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function asObject(value: unknown, path: string): SchemaDocument {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SchemaError(`${path}: expected object, got ${describeValue(value)}`)
  }
  return value as SchemaDocument
}

function objectField(obj: SchemaDocument, key: string, path: string): SchemaDocument {
  return asObject(obj[key], `${path}.${key}`)
}

function arrayField(obj: SchemaDocument, key: string, path: string): unknown[] {
  const value = obj[key]
  if (!Array.isArray(value)) {
    throw new SchemaError(`${path}.${key}: expected array, got ${describeValue(value)}`)
  }
  return value
}

function asString(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw new SchemaError(`${path}: expected string, got ${describeValue(value)}`)
  }
  return value
}

function stringField(obj: SchemaDocument, key: string, path: string): string {
  return asString(obj[key], `${path}.${key}`)
}

function nonEmptyStringField(obj: SchemaDocument, key: string, path: string): string {
  const value = stringField(obj, key, path)
  if (value === '') {
    throw new SchemaError(`${path}.${key}: expected non-empty string, got ""`)
  }
  return value
}

function optionalStringField(obj: SchemaDocument, key: string, path: string): string | undefined {
  return obj[key] === undefined ? undefined : stringField(obj, key, path)
}

function booleanField(obj: SchemaDocument, key: string, path: string): boolean {
  const value = obj[key]
  if (typeof value !== 'boolean') {
    throw new SchemaError(`${path}.${key}: expected boolean, got ${describeValue(value)}`)
  }
  return value
}

function finiteNumberField(obj: SchemaDocument, key: string, path: string): number {
  const value = obj[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new SchemaError(`${path}.${key}: expected finite number, got ${describeValue(value)}`)
  }
  return value
}

function nonNegativeNumberField(obj: SchemaDocument, key: string, path: string): number {
  const value = finiteNumberField(obj, key, path)
  if (value < 0) {
    throw new SchemaError(`${path}.${key}: expected number ≥ 0, got ${String(value)}`)
  }
  return value
}

function positiveIntegerField(obj: SchemaDocument, key: string, path: string): number {
  const value = finiteNumberField(obj, key, path)
  if (!Number.isInteger(value) || value < 1) {
    throw new SchemaError(`${path}.${key}: expected integer ≥ 1, got ${String(value)}`)
  }
  return value
}

// Dates are stored as ISO 8601 strings; parseability is semantically required
// (session ordering and record views compare them), so it IS validated.
function isoDateField(obj: SchemaDocument, key: string, path: string): IsoDateString {
  const value = stringField(obj, key, path)
  if (Number.isNaN(Date.parse(value))) {
    throw new SchemaError(`${path}.${key}: expected ISO 8601 date string, got "${value}"`)
  }
  return value
}

function enumField<T extends string>(
  obj: SchemaDocument,
  key: string,
  path: string,
  allowed: readonly T[],
): T {
  const value = obj[key]
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new SchemaError(
      `${path}.${key}: expected one of ${allowed.map((v) => `"${v}"`).join(' | ')}, got ${
        typeof value === 'string' ? `"${value}"` : describeValue(value)
      }`,
    )
  }
  return value as T
}

function parseCourse(value: unknown, path: string): Course {
  const obj = asObject(value, path)
  return {
    id: stringField(obj, 'id', path),
    name: stringField(obj, 'name', path),
    direction: enumField<CrossingDirection>(obj, 'direction', path, ['ltr', 'rtl']),
    minLapTimeMs: nonNegativeNumberField(obj, 'minLapTimeMs', path),
    createdAt: isoDateField(obj, 'createdAt', path),
  }
}

function parsePendingCourseDeletion(value: unknown, path: string): PendingCourseDeletion {
  const obj = asObject(value, path)
  const sessionIdsPath = `${path}.sessionIds`
  return {
    courseId: nonEmptyStringField(obj, 'courseId', path),
    courseName: stringField(obj, 'courseName', path),
    sessionIds: arrayField(obj, 'sessionIds', path).map((id, i) =>
      asString(id, `${sessionIdsPath}[${i}]`),
    ),
  }
}

// This function builds a FRESH object from known keys — an unparsed key is a
// key silently dropped on every read. pendingCourseDeletions is read here, or
// the intent marker would be written to disk and lost, leaving the whole
// crash-recovery mechanism inert.
function parseSettings(value: unknown, path: string): AppSettings {
  const obj = asObject(value, path)
  const settings: AppSettings = { speechEnabled: booleanField(obj, 'speechEnabled', path) }
  const lastExportAt = obj.lastExportAt === undefined ? undefined : isoDateField(obj, 'lastExportAt', path)
  const lastCourseId = optionalStringField(obj, 'lastCourseId', path)
  if (lastExportAt !== undefined) settings.lastExportAt = lastExportAt
  if (lastCourseId !== undefined) settings.lastCourseId = lastCourseId
  if (obj.pendingCourseDeletions !== undefined) {
    const pendingPath = `${path}.pendingCourseDeletions`
    settings.pendingCourseDeletions = arrayField(obj, 'pendingCourseDeletions', path).map(
      (pending, i) => parsePendingCourseDeletion(pending, `${pendingPath}[${i}]`),
    )
  }
  return settings
}

function parseRoi(value: unknown, path: string): NormalizedRect {
  const obj = asObject(value, path)
  return {
    x: finiteNumberField(obj, 'x', path),
    y: finiteNumberField(obj, 'y', path),
    width: finiteNumberField(obj, 'width', path),
    height: finiteNumberField(obj, 'height', path),
  }
}

function parseTunables(value: unknown, path: string): DetectionTunables {
  const obj = asObject(value, path)
  return {
    roi: parseRoi(obj.roi, `${path}.roi`),
    stripCount: positiveIntegerField(obj, 'stripCount', path),
    triggerLevel: finiteNumberField(obj, 'triggerLevel', path),
    emaTimeConstantMs: finiteNumberField(obj, 'emaTimeConstantMs', path),
    threshold: finiteNumberField(obj, 'threshold', path),
  }
}

function parseDetector(value: unknown, path: string): CrossingDetectorConfig {
  const obj = asObject(value, path)
  return {
    triggerLevel: finiteNumberField(obj, 'triggerLevel', path),
    hysteresisRatio: finiteNumberField(obj, 'hysteresisRatio', path),
    entryZoneStrips: finiteNumberField(obj, 'entryZoneStrips', path),
    maxBackstepStrips: finiteNumberField(obj, 'maxBackstepStrips', path),
    minTraversalMs: finiteNumberField(obj, 'minTraversalMs', path),
    maxTraversalMs: finiteNumberField(obj, 'maxTraversalMs', path),
    minParticipatingStrips: finiteNumberField(obj, 'minParticipatingStrips', path),
    transientStripFraction: finiteNumberField(obj, 'transientStripFraction', path),
    transientHoldoffMs: finiteNumberField(obj, 'transientHoldoffMs', path),
    maxPauseMs: finiteNumberField(obj, 'maxPauseMs', path),
  }
}

function parseDetectionConfig(value: unknown, path: string): SessionDetectionConfig {
  const obj = asObject(value, path)
  return {
    tunables: parseTunables(obj.tunables, `${path}.tunables`),
    detector: parseDetector(obj.detector, `${path}.detector`),
  }
}

function parseLap(value: unknown, path: string): Lap {
  const obj = asObject(value, path)
  return {
    n: positiveIntegerField(obj, 'n', path),
    durationMs: nonNegativeNumberField(obj, 'durationMs', path),
    completedAt: isoDateField(obj, 'completedAt', path),
    status: enumField<Lap['status']>(obj, 'status', path, ['valid', 'discarded']),
  }
}

function parseSession(value: unknown, path: string): Session {
  const obj = asObject(value, path)
  const lapsPath = `${path}.laps`
  return {
    id: stringField(obj, 'id', path),
    courseId: stringField(obj, 'courseId', path),
    startedAt: isoDateField(obj, 'startedAt', path),
    note: stringField(obj, 'note', path),
    detectionConfig: parseDetectionConfig(obj.detectionConfig, `${path}.detectionConfig`),
    laps: arrayField(obj, 'laps', path).map((lap, i) => parseLap(lap, `${lapsPath}[${i}]`)),
  }
}

// Exported for the driver-behavior tests (chain stamping needs a target
// version above the shipped SCHEMA_VERSION); production reads go through the
// parse* functions, which always target SCHEMA_VERSION.
export function migrateToCurrent(
  doc: unknown,
  kind: DocumentKind,
  targetVersion: number = SCHEMA_VERSION,
): SchemaDocument {
  const obj = asObject(doc, '$')
  const version = obj.schemaVersion
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    throw new SchemaError(
      `$.schemaVersion: expected non-negative integer, got ${
        typeof version === 'number' ? String(version) : describeValue(version)
      }`,
    )
  }
  if (version > targetVersion) {
    throw new SchemaVersionError(
      `$.schemaVersion: ${String(version)} is newer than this app's schema (${String(targetVersion)}); refusing to read`,
    )
  }
  let current = obj
  for (let from = version; from < targetVersion; from++) {
    const migrate = migrations[from]
    if (!migrate) {
      throw new SchemaVersionError(
        `$.schemaVersion: no migration registered from version ${String(from)}`,
      )
    }
    current = { ...migrate(current, kind), schemaVersion: from + 1 }
  }
  return current
}

// Each parse* takes an already-JSON.parse'd document (the file layer maps
// JSON.parse failures to its own corrupt-file handling), migrates it to
// SCHEMA_VERSION, and validates it structurally. Throws SchemaError.

export function parseCoursesFile(doc: unknown): CoursesFile {
  const obj = migrateToCurrent(doc, 'courses')
  return {
    schemaVersion: SCHEMA_VERSION,
    courses: arrayField(obj, 'courses', '$').map((course, i) => parseCourse(course, `$.courses[${i}]`)),
    settings: parseSettings(objectField(obj, 'settings', '$'), '$.settings'),
  }
}

export function parseSessionFile(doc: unknown): SessionFile {
  const obj = migrateToCurrent(doc, 'session')
  return { schemaVersion: SCHEMA_VERSION, ...parseSession(obj, '$') }
}

export function parseExportEnvelope(doc: unknown): ExportEnvelope {
  const obj = migrateToCurrent(doc, 'export')
  return {
    schemaVersion: SCHEMA_VERSION,
    exportedAt: isoDateField(obj, 'exportedAt', '$'),
    courses: arrayField(obj, 'courses', '$').map((course, i) => parseCourse(course, `$.courses[${i}]`)),
    settings: parseSettings(objectField(obj, 'settings', '$'), '$.settings'),
    sessions: arrayField(obj, 'sessions', '$').map((session, i) => parseSession(session, `$.sessions[${i}]`)),
  }
}
