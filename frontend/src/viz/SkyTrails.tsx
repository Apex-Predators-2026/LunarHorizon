import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import type { TimelineStep } from '../types'
import { skyTrail } from './geometry'

const SUN = { visible: [1, 0.85, 0.45], blocked: [0.45, 0.32, 0.12], unknown: [0.4, 0.4, 0.4] } as const
const EARTH = { visible: [0.4, 0.65, 1], blocked: [0.16, 0.25, 0.45], unknown: [0.4, 0.4, 0.4] } as const

/**
 * The Sun's and Earth's paths across the sky over the loaded time window (one segment per hour),
 * bright where they clear the terrain and dim where it blocks them. Shows at a glance how the
 * Sun skims the horizon at the pole and how Earth wobbles (libration). Render inside
 * <FollowCamera>, just inside the Sun/Earth discs' distance.
 */
export function SkyTrails({ steps, radius }: { steps: TimelineStep[]; radius: number }) {
  const geometries = useMemo(
    () =>
      (['sun', 'earth'] as const).map((body) => {
        const c = body === 'sun' ? SUN : EARTH
        const { positions, colors } = skyTrail(steps, body, radius, {
          visible: [...c.visible],
          blocked: [...c.blocked],
          unknown: [...c.unknown],
        })
        const g = new THREE.BufferGeometry()
        g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
        g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
        return g
      }),
    [steps, radius],
  )
  const material = useMemo(() => new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false }), [])
  useEffect(() => () => geometries.forEach((g) => g.dispose()), [geometries])
  useEffect(() => () => material.dispose(), [material])
  return (
    <group>
      {geometries.map((g, i) => (
        <lineSegments key={i} geometry={g} material={material} />
      ))}
    </group>
  )
}
