import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import type { TimelineStep } from '../types'

const DEG = Math.PI / 180
export const BEACON_HEIGHT = 120
export const BEACON_HIDE_WITHIN_M = 400 // closer than this, the lander itself is visible

/**
 * Simple lander built from primitives (~4 m tall). The vertical solar panel turns to face the
 * Sun's azimuth and the dish points at Earth, so their aim matches the computed positions.
 * A thin beacon line makes the landing spot findable from kilometres away.
 */
export function Lander({
  status,
  observerHeight,
  showBeacon,
}: {
  status: TimelineStep | null
  observerHeight: number
  showBeacon: boolean
}) {
  // Rotation about y so local -z faces the given azimuth (x = east, z = -north).
  const yawTo = (azDeg: number) => -azDeg * DEG
  const sunAz = status?.sun.azimuth_deg ?? 0
  const earthAz = status?.earth.azimuth_deg ?? 0
  const earthEl = status?.earth.elevation_deg ?? 0

  return (
    <group>
      {/* Legs */}
      {[45, 135, 225, 315].map((a) => (
        <mesh key={a} position={[Math.sin(a * DEG) * 1.6, 0.8, -Math.cos(a * DEG) * 1.6]} castShadow>
          <cylinderGeometry args={[0.06, 0.06, 1.8]} />
          <meshStandardMaterial color="#c9c9c9" />
        </mesh>
      ))}
      {/* Body */}
      <mesh position={[0, 1.8, 0]} castShadow>
        <cylinderGeometry args={[1.2, 1.4, 1.4, 8]} />
        <meshStandardMaterial color="#d4a017" metalness={0.6} roughness={0.35} />
      </mesh>
      {/* Mast + vertical solar panel facing the Sun */}
      <mesh position={[0, observerHeight + 0.6, 0]} castShadow>
        <cylinderGeometry args={[0.05, 0.05, 1.6]} />
        <meshStandardMaterial color="#888" />
      </mesh>
      <group position={[0, observerHeight + 1.2, 0]} rotation={[0, yawTo(sunAz), 0]}>
        <mesh position={[0, 0, -0.1]} castShadow>
          <boxGeometry args={[2.4, 1.4, 0.05]} />
          <meshStandardMaterial color="#1e3a8a" metalness={0.3} roughness={0.4} />
        </mesh>
      </group>
      {/* Dish pointed at Earth */}
      <group position={[0, 2.8, 0]} rotation={[0, yawTo(earthAz), 0]}>
        <group rotation={[earthEl * DEG, 0, 0]}>
          {/* Cone tip points back (+z), so the open dish faces -z, towards Earth */}
          <mesh position={[0, 0, -0.3]} rotation={[Math.PI / 2, 0, 0]} castShadow>
            <coneGeometry args={[0.5, 0.3, 24, 1, true]} />
            <meshStandardMaterial color="#e5e7eb" side={THREE.DoubleSide} />
          </mesh>
        </group>
      </group>
      {showBeacon && <Beacon />}
    </group>
  )
}

/**
 * Marks the landing spot from kilometres away. A 1-pixel line (not a solid column), so it can
 * never cover the view, and hidden once the camera is close enough to see the lander itself.
 */
function Beacon() {
  const line = useMemo(() => {
    const geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 5, 0),
      new THREE.Vector3(0, BEACON_HEIGHT, 0),
    ])
    return new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: '#f97316' }))
  }, [])
  useEffect(() => () => {
    line.geometry.dispose()
    ;(line.material as THREE.Material).dispose()
  }, [line])
  const ref = useRef<THREE.Line>(null)
  useFrame(({ camera }) => {
    if (ref.current) ref.current.visible = camera.position.length() > BEACON_HIDE_WITHIN_M
  })
  return <primitive ref={ref} object={line} />
}
