import { useMemo } from 'react'
import * as THREE from 'three'
import type { Horizon } from '../types'
import { buildHorizonCurtain } from './geometry'

/**
 * The computed terrain horizon (720 directions, out to 300 km) drawn as a distant curtain, from
 * the skyline (orange line) down to almost straight below, so it reads as far-away ground.
 * Render it inside <FollowCamera>: Sun/Earth sit just beyond it, so they disappear behind it
 * exactly when the engine says terrain blocks them.
 */
export function HorizonCurtain({ horizon, radius }: { horizon: Horizon; radius: number }) {
  const { mesh, line } = useMemo(() => {
    const { positions, indices, topLine } = buildHorizonCurtain(horizon.azimuth_deg, horizon.elevation_deg, radius, -89)
    const mesh = new THREE.BufferGeometry()
    mesh.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    mesh.setIndex(new THREE.BufferAttribute(indices, 1))
    const line = new THREE.BufferGeometry()
    line.setAttribute('position', new THREE.BufferAttribute(topLine, 3))
    return { mesh, line }
  }, [horizon, radius])

  return (
    <group>
      <mesh geometry={mesh}>
        <meshBasicMaterial color="#1b1c20" side={THREE.DoubleSide} />
      </mesh>
      <lineLoop geometry={line}>
        <lineBasicMaterial color="#f59e0b" />
      </lineLoop>
    </group>
  )
}
