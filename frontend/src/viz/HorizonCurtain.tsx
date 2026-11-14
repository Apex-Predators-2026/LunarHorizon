import { useMemo } from 'react'
import * as THREE from 'three'
import type { Horizon } from '../types'
import { buildHorizonCurtain } from './geometry'

/**
 * The computed terrain horizon (720 directions, out to 300 km) drawn as a distant curtain around
 * the observer. Sun/Earth sit just beyond it, so they disappear behind it exactly when the
 * engine says terrain blocks them. The orange line is the skyline itself.
 */
export function HorizonCurtain({ horizon, radius, eyeHeight }: { horizon: Horizon; radius: number; eyeHeight: number }) {
  const { mesh, line } = useMemo(() => {
    const { positions, indices, topLine } = buildHorizonCurtain(horizon.azimuth_deg, horizon.elevation_deg, radius)
    const mesh = new THREE.BufferGeometry()
    mesh.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    mesh.setIndex(new THREE.BufferAttribute(indices, 1))
    const line = new THREE.BufferGeometry()
    line.setAttribute('position', new THREE.BufferAttribute(topLine, 3))
    return { mesh, line }
  }, [horizon, radius])

  return (
    <group position={[0, eyeHeight, 0]}>
      <mesh geometry={mesh}>
        <meshBasicMaterial color="#26272c" side={THREE.DoubleSide} />
      </mesh>
      <lineLoop geometry={line}>
        <lineBasicMaterial color="#f59e0b" />
      </lineLoop>
    </group>
  )
}
