// Hand-rolled hash routing (ADR 0007, params added in Phase 6). Hash forms:
// #/ (home), #/diag, #/lab, #/fly/<courseId>, #/course/<id>, #/session/<id>,
// #/course/new, #/course/<id>/edit, #/course/<id>/delete,
// #/session/<id>/delete. Anything unknown or malformed maps to home. Ids are
// opaque non-empty segments (crypto.randomUUID in practice); "new" is reserved
// by the #/course/new form and can never be a course id in a parsed route.

export type Route =
  | { id: 'home' }
  | { id: 'diag' }
  | { id: 'lab' }
  | { id: 'fly'; courseId: string }
  | { id: 'course'; courseId: string }
  | { id: 'session'; sessionId: string }
  | { id: 'new-course' }
  | { id: 'edit-course'; courseId: string }
  | { id: 'delete-course'; courseId: string }
  | { id: 'delete-session'; sessionId: string }

const HOME: Route = { id: 'home' }

export function routeFromHash(hash: string): Route {
  if (!hash.startsWith('#/')) return HOME
  if (hash === '#/') return HOME
  const segments = hash.slice(2).split('/')
  if (segments.some((segment) => segment === '')) return HOME
  switch (segments[0]) {
    case 'diag':
      return segments.length === 1 ? { id: 'diag' } : HOME
    case 'lab':
      return segments.length === 1 ? { id: 'lab' } : HOME
    case 'fly':
      return segments.length === 2 ? { id: 'fly', courseId: segments[1] } : HOME
    case 'session':
      if (segments.length === 2) return { id: 'session', sessionId: segments[1] }
      if (segments.length === 3 && segments[2] === 'delete') {
        return { id: 'delete-session', sessionId: segments[1] }
      }
      return HOME
    case 'course':
      if (segments.length === 2) {
        return segments[1] === 'new'
          ? { id: 'new-course' }
          : { id: 'course', courseId: segments[1] }
      }
      if (segments.length === 3 && segments[1] !== 'new') {
        if (segments[2] === 'edit') return { id: 'edit-course', courseId: segments[1] }
        if (segments[2] === 'delete') return { id: 'delete-course', courseId: segments[1] }
      }
      return HOME
    default:
      return HOME
  }
}

// The single source of hash strings for links and navigation
// (`location.hash = hashFor(route)`); routeFromHash(hashFor(r)) === r.
export function hashFor(route: Route): string {
  switch (route.id) {
    case 'home':
      return '#/'
    case 'diag':
      return '#/diag'
    case 'lab':
      return '#/lab'
    case 'fly':
      return `#/fly/${route.courseId}`
    case 'course':
      return `#/course/${route.courseId}`
    case 'session':
      return `#/session/${route.sessionId}`
    case 'new-course':
      return '#/course/new'
    case 'edit-course':
      return `#/course/${route.courseId}/edit`
    case 'delete-course':
      return `#/course/${route.courseId}/delete`
    case 'delete-session':
      return `#/session/${route.sessionId}/delete`
  }
}

export function isGateExempt(route: Route): boolean {
  return route.id === 'diag' || route.id === 'lab'
}

export function shouldShowUnsupportedScreen(capabilitiesOk: boolean, route: Route): boolean {
  return !capabilitiesOk && !isGateExempt(route)
}
