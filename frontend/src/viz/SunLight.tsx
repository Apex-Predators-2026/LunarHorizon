import type { SiteStatus } from '../types'
import { azElToVector } from './geometry'

const MAX_INTENSITY = 3

/**
 * Sunlight from the computed azimuth/elevation. Intensity scales with the visible fraction of the
 * solar disk, which already accounts for distant terrain (up to 300 km) that this 10 km mesh can't
 * show. Local shadows come from the shadow map.
 */
export function SunLight({ status, shadowHalfWidth }: { status: SiteStatus; shadowHalfWidth: number }) {
  const { sun } = status
  const pos = azElToVector(sun.azimuth_deg, sun.elevation_deg, 20000)
  const intensity = MAX_INTENSITY * sun.visible_fraction

  return (
    <directionalLight
      position={pos}
      intensity={intensity}
      castShadow={intensity > 0}
      shadow-mapSize={[4096, 4096]}
      shadow-camera-left={-shadowHalfWidth}
      shadow-camera-right={shadowHalfWidth}
      shadow-camera-top={shadowHalfWidth}
      shadow-camera-bottom={-shadowHalfWidth}
      shadow-camera-near={1}
      shadow-camera-far={45000}
      shadow-bias={-0.0004}
      shadow-normalBias={8}
    />
  )
}
