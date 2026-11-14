import { useMemo } from 'react'
import * as THREE from 'three'
import type { TerrainGrid } from '../types'
import { buildTerrainMesh } from './geometry'

/** LOLA height grid around the site as a lit, shadow-casting surface. Site ground = y 0. */
export function Terrain({ grid }: { grid: TerrainGrid }) {
  const geometry = useMemo(() => {
    const { positions, indices } = buildTerrainMesh(grid.heights_m, grid.size, grid.half_width_m, grid.site_height_m)
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    g.setIndex(new THREE.BufferAttribute(indices, 1))
    g.computeVertexNormals()
    return g
  }, [grid])

  return (
    <mesh geometry={geometry} castShadow receiveShadow>
      <meshStandardMaterial color="#9a9a9a" roughness={0.95} metalness={0} />
    </mesh>
  )
}
