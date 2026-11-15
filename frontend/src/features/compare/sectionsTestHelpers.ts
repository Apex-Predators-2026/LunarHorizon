// Test helper: the route a comparison section's URL parses to.
import { parseRoute, routeHash } from '../../appRoute'

export const appRoute = (section: string | null) => {
  const r = parseRoute(routeHash('compare', section))
  if (r.page !== 'app') throw new Error('not an app route')
  return r
}
