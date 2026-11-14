import type { SiteStatus } from '../types'
import { skyPositions } from './geometry'

const SUN_RADIUS_DEG = 0.2666 // apparent solar radius
const EARTH_RADIUS_DEG = 0.95 // Earth seen from the Moon (6371 km / 384,400 km)

function radiusAt(distance: number, angularRadiusDeg: number) {
  return distance * Math.tan((angularRadiusDeg * Math.PI) / 180)
}

/**
 * Sun and Earth at their true angular size and position, just beyond the horizon curtain.
 * Render inside <FollowCamera> (positions are relative to the viewer).
 */
export function SkyBodies({ status, distance }: { status: SiteStatus; distance: number }) {
  const pos = skyPositions(status, distance, 0)
  return (
    <>
      <mesh position={pos.sun}>
        <sphereGeometry args={[radiusAt(distance, SUN_RADIUS_DEG), 32, 16]} />
        <meshBasicMaterial color="#fff4d6" toneMapped={false} />
      </mesh>
      <mesh position={pos.earth}>
        <sphereGeometry args={[radiusAt(distance, EARTH_RADIUS_DEG), 32, 16]} />
        <meshBasicMaterial color={status.earth.visible ? '#4f8fe8' : '#2c4f80'} toneMapped={false} />
      </mesh>
    </>
  )
}
