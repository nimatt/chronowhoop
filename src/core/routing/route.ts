export type RouteId = 'home' | 'diag' | 'lab'

export function routeFromHash(hash: string): RouteId {
  switch (hash) {
    case '#/diag':
      return 'diag'
    case '#/lab':
      return 'lab'
    default:
      return 'home'
  }
}

export function isGateExempt(route: RouteId): boolean {
  return route === 'diag' || route === 'lab'
}

export function shouldShowUnsupportedScreen(capabilitiesOk: boolean, route: RouteId): boolean {
  return !capabilitiesOk && !isGateExempt(route)
}
