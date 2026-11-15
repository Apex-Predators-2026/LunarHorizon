import type { TimelineStep } from '../types'
import { azElToVector, earthIlluminatedFraction } from './geometry'

/**
 * Display aid for terrain the Sun doesn't reach: a faint light from Earth's real direction, as
 * bright as Earth's phase allows (full Earth brightest), so shadowed ground still shows its shape
 * where earthshine actually falls. Real earthshine is ~10^-5 of sunlight, far too dim to render, so
 * this is exaggerated; but it is never brighter than the low polar Sun (3 x sin 1.5 deg ~ 0.08), so
 * sunlit and shadowed ground stay clearly apart, and with Earth below the horizon (the far side,
 * deep crater floors) there is only the faint ambient: permanently shadowed regions look dark.
 */
export const EARTHSHINE_MAX = 0.05
export const AMBIENT = 0.02

export function EarthShine({ status }: { status: TimelineStep | null }) {
  const earth = status?.earth
  // Earth just below the flat horizon still lights raised ground; fade it out over the last 2 deg.
  const aboveHorizon = earth ? Math.min(1, Math.max(0, (earth.elevation_deg + 2) / 2)) : 0
  const phase = status ? earthIlluminatedFraction(status.sun, status.earth) : 0
  const intensity = EARTHSHINE_MAX * phase * aboveHorizon
  return (
    <>
      <ambientLight intensity={AMBIENT} />
      {earth && intensity > 0.001 && (
        <directionalLight position={azElToVector(earth.azimuth_deg, earth.elevation_deg, 20000)} intensity={intensity} />
      )}
    </>
  )
}
