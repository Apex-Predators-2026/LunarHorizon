// Mount only when PERF_ENABLED (see perf.ts): a measuring tool for the demo tour, not part of the app.
import { useThree } from '@react-three/fiber'
import { useEffect } from 'react'
import * as THREE from 'three'
import { azElToVector } from './geometry'

declare global {
  interface Window {
    __horizon?: { at: (azimuthDeg: number) => number | null; tiles: () => number }
  }
}

const RANGE_M = 400_000 // the engine's horizon looks 300 km out; a little more
const EL_LOW = -10 // deg: below this every direction should hit the ground
const EL_HIGH = 40 // deg: above this nothing at the south pole should

/**
 * window.__horizon.at(az): the elevation (deg) of the skyline of the 3D terrain *as drawn right now* seen from
 * the lander's eye, by bisecting on rays against the terrain tiles. The demo tour compares it with the
 * engine's horizon mask (/api/sites/{id}/horizon) to check that what the 3D view shows agrees with what the
 * engine computes. null if even EL_LOW clears the terrain (nothing drawn there).
 */
export function HorizonProbe({ eyeHeightM }: { eyeHeightM: number }) {
  const scene = useThree((s) => s.scene)
  useEffect(() => {
    const raycaster = new THREE.Raycaster()
    raycaster.far = RANGE_M
    const eye = new THREE.Vector3(0, eyeHeightM, 0) // the lander is at the site frame's origin
    const blocked = (az: number, el: number) => {
      const tiles = scene.getObjectByName('terrain-tiles')
      if (!tiles) return false
      raycaster.set(eye, new THREE.Vector3(...azElToVector(az, el)))
      return raycaster.intersectObject(tiles, true).length > 0
    }
    window.__horizon = {
      at: (az) => {
        if (!blocked(az, EL_LOW)) return null
        let lo = EL_LOW // blocked
        let hi = EL_HIGH // assumed clear
        if (blocked(az, hi)) return hi
        for (let k = 0; k < 14; k++) {
          const mid = (lo + hi) / 2
          if (blocked(az, mid)) lo = mid
          else hi = mid
        }
        return (lo + hi) / 2 // to ~0.003 deg
      },
      tiles: () => scene.getObjectByName('terrain-tiles')?.children.length ?? 0,
    }
    return () => {
      delete window.__horizon
    }
  }, [scene, eyeHeightM])
  return null
}
