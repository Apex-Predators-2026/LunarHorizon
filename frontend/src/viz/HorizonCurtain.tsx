import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import type { Horizon } from '../types'
import { buildHorizonCurtain } from './geometry'

// The curtain is the horizon as seen from the lander, so it only makes sense with the camera at
// the lander. Further away it would wrap the camera in a dark shell and hide the whole Moon
// (e.g. zooming out while still in the Sun / Earth view). The views put the camera at the lander's
// eye (CameraRig); a few hundred metres away nearby rims no longer line up with the line.
const SHOW_WITHIN_M = 200

/**
 * The computed terrain horizon (720 directions, out to 300 km) drawn as a distant curtain, from
 * the skyline (orange line) down to almost straight below, so it reads as far-away ground.
 * Render it inside <FollowCamera>: Sun/Earth sit just beyond it, so they disappear behind it
 * exactly when the engine says terrain blocks them. Hidden when the camera leaves the lander.
 */
export function HorizonCurtain({ horizon, radius }: { horizon: Horizon; radius: number }) {
  const { mesh, line } = useMemo(() => {
    // Unknown directions (missing terrain; custom sites only) are drawn at 0°, the flat horizon.
    const elevations = horizon.elevation_deg.map((e) => e ?? 0)
    const { positions, indices, topLine } = buildHorizonCurtain(horizon.azimuth_deg, elevations, radius, -89)
    const mesh = new THREE.BufferGeometry()
    mesh.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    mesh.setIndex(new THREE.BufferAttribute(indices, 1))
    const line = new THREE.BufferGeometry()
    line.setAttribute('position', new THREE.BufferAttribute(topLine, 3))
    return { mesh, line }
  }, [horizon, radius])
  useEffect(
    () => () => {
      mesh.dispose()
      line.dispose()
    },
    [mesh, line],
  )

  const group = useRef<THREE.Group>(null)
  useFrame(({ camera }) => {
    // The site frame's origin is the lander's ground point.
    if (group.current) group.current.visible = camera.position.length() < SHOW_WITHIN_M
  })

  return (
    <group ref={group}>
      <mesh geometry={mesh}>
        <meshBasicMaterial color="#1b1c20" side={THREE.DoubleSide} />
      </mesh>
      <lineLoop geometry={line}>
        <lineBasicMaterial color="#f59e0b" />
      </lineLoop>
    </group>
  )
}
