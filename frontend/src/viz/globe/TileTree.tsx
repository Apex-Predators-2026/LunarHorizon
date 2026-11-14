// Streaming, level-of-detail terrain for the whole Moon (cube-sphere quadtree).
// Tiles come from /api/terrain/tile (backend/app/terrain_router.py), are built in the site frame
// (see SiteFrame) and refined until each vertex step covers < ~4 px on screen.
// Works with frameloop="demand": tile selection only runs when the camera moved or a tile arrived,
// and the shadow map is only redrawn when the set of drawn tiles changes.
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { API_URL } from '../api'
import { PERF_ENABLED, recordTileBuild, recordTileLevels } from '../perf'
import { MAX_ZOOM, MOON_RADIUS_M, SiteFrame, TILE_N, tileVertexUV, uvToVec, vertexSpacingM, type Vec3 } from './cubeSphere'
import { buildTileMesh } from './tileGeometry'

const SSE_THRESHOLD_PX = 4 // refine while a vertex step spans more than this on screen
const MAX_IN_FLIGHT = 6
const MAX_CACHED_MESHES = 500
const UPDATE_EVERY_MS = 60 // at most this often while the camera moves

type State = 'idle' | 'loading' | 'ready' | 'error'

interface TileNode {
  key: string
  face: number
  z: number
  x: number
  y: number
  state: State
  leaf: boolean // no finer data below (from the server); assumed false until loaded
  centre: Vec3 // site frame (approximate until loaded)
  radius: number
  mesh: THREE.Mesh | null
  lastUsed: number
}

export interface TileStats {
  visible: number
  loading: number
  cached: number
  deepest: number
}

const keyOf = (f: number, z: number, x: number, y: number) => `${f}/${z}/${x}/${y}`

// Scratch objects for the per-frame selection (one TileTree per scene).
const frustum = new THREE.Frustum()
const projView = new THREE.Matrix4()
const sphere = new THREE.Sphere()
const lastView = new THREE.Matrix4() // camera at the last selection
const lastProj = new THREE.Matrix4()

/** Rough bounding sphere of a tile before its heights are known (on the reference sphere). */
function approxBounds(frame: SiteFrame, f: number, z: number, x: number, y: number): [Vec3, number] {
  const mid = uvToVec(f, ...tileVertexUV(z, x, y, TILE_N >> 1, TILE_N >> 1))
  const corner = uvToVec(f, ...tileVertexUV(z, x, y, 0, 0))
  const c = frame.toSite([mid[0] * MOON_RADIUS_M, mid[1] * MOON_RADIUS_M, mid[2] * MOON_RADIUS_M])
  const k = frame.toSite([corner[0] * MOON_RADIUS_M, corner[1] * MOON_RADIUS_M, corner[2] * MOON_RADIUS_M])
  const r = Math.hypot(k[0] - c[0], k[1] - c[1], k[2] - c[2]) * 1.5 + 12_000 // + relief
  return [c, r]
}

export function TileTree({
  frame,
  material,
  onStats,
  onPick,
}: {
  frame: SiteFrame
  material: THREE.Material
  onStats?: (s: TileStats) => void
  onPick?: (point: Vec3) => void // a click on the terrain (not an orbit drag), in the site frame
}) {
  const group = useRef<THREE.Group>(null)
  const nodes = useRef(new Map<string, TileNode>())
  const inFlight = useRef(0)
  const queue = useRef<TileNode[]>([])
  const lastUpdate = useRef(0)
  const dirty = useRef(true) // a tile arrived (or the site changed) since the last selection
  const lastSize = useRef('')
  const camera = useThree((s) => s.camera)
  const size = useThree((s) => s.size)
  const invalidate = useThree((s) => s.invalidate)

  // A different site means a different frame: drop everything.
  useEffect(() => {
    const map = nodes.current
    dirty.current = true
    invalidate()
    return () => {
      for (const n of map.values()) n.mesh?.geometry.dispose()
      map.clear()
      queue.current = []
    }
  }, [frame, invalidate])

  const node = (f: number, z: number, x: number, y: number): TileNode => {
    const key = keyOf(f, z, x, y)
    let n = nodes.current.get(key)
    if (!n) {
      const [centre, radius] = approxBounds(frame, f, z, x, y)
      n = { key, face: f, z, x, y, state: 'idle', leaf: z >= MAX_ZOOM, centre, radius, mesh: null, lastUsed: 0 }
      nodes.current.set(key, n)
    }
    return n
  }

  const load = (n: TileNode) => {
    n.state = 'loading'
    inFlight.current++
    fetch(`${API_URL}/api/terrain/tile/${n.face}/${n.z}/${n.x}/${n.y}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`tile ${n.key}: HTTP ${res.status}`)
        n.leaf = res.headers.get('X-Tile-Leaf') === '1' || n.z >= MAX_ZOOM
        const heights = new Float32Array(await res.arrayBuffer())
        if (!nodes.current.has(n.key)) return // site changed meanwhile
        const t0 = performance.now()
        const m = buildTileMesh(n.face, n.z, n.x, n.y, heights, frame)
        const geom = new THREE.BufferGeometry()
        geom.setAttribute('position', new THREE.BufferAttribute(m.positions, 3))
        // Normals from the surface triangles only: the vertical skirt walls would tilt the edge
        // normals sideways and light up every tile border as a bright line.
        geom.setIndex(new THREE.BufferAttribute(m.indices.subarray(0, m.surfaceIndexCount), 1))
        geom.computeVertexNormals()
        const nrm = geom.getAttribute('normal') as THREE.BufferAttribute
        m.borderOf.forEach((g, s) => nrm.setXYZ(m.skirtStart + s, nrm.getX(g), nrm.getY(g), nrm.getZ(g)))
        geom.setIndex(new THREE.BufferAttribute(m.indices, 1))
        recordTileBuild(performance.now() - t0)
        const mesh = new THREE.Mesh(geom, material)
        mesh.position.set(...m.centre)
        mesh.castShadow = true
        mesh.receiveShadow = true
        mesh.matrixAutoUpdate = false
        mesh.updateMatrix()
        mesh.userData.tile = n.key
        n.centre = m.centre
        n.radius = m.radius
        n.mesh = mesh
        n.state = 'ready'
      })
      .catch(() => {
        n.state = 'error'
      })
      .finally(() => {
        inFlight.current--
        pump() // keep the connections busy between selections
        dirty.current = true // reselect on the next frame
        invalidate()
      })
  }

  /** Start queued loads (from the last selection) up to MAX_IN_FLIGHT, skipping stale entries. */
  const pump = () => {
    while (inFlight.current < MAX_IN_FLIGHT && queue.current.length) {
      const n = queue.current.shift()!
      if (n.state === 'idle' && nodes.current.get(n.key) === n) load(n)
    }
  }

  useFrame(({ gl }) => {
    const g = group.current
    if (!g) return
    const sizeKey = `${size.width}x${size.height}`
    const moved =
      !lastView.equals(camera.matrixWorld) || !lastProj.equals(camera.projectionMatrix) || lastSize.current !== sizeKey
    if (!moved && !dirty.current) return // nothing changed: keep the current selection
    const now = performance.now()
    if (now - lastUpdate.current < UPDATE_EVERY_MS) {
      invalidate() // come back once the throttle allows (otherwise an idle canvas would never reselect)
      return
    }
    lastUpdate.current = now
    lastView.copy(camera.matrixWorld)
    lastProj.copy(camera.projectionMatrix)
    lastSize.current = sizeKey
    dirty.current = false

    projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    frustum.setFromProjectionMatrix(projView)
    const cam = camera.position
    const fov = (camera as THREE.PerspectiveCamera).fov ?? 50
    const pxPerRad = size.height / (2 * Math.tan(((fov * Math.PI) / 180) / 2))
    // Horizon culling: from the camera, nothing beyond the Moon's limb is visible.
    const mc = frame.moonCentre
    const dc = Math.hypot(cam.x - mc[0], cam.y - mc[1], cam.z - mc[2])
    const horizonDist = Math.sqrt(Math.max(0, dc * dc - (MOON_RADIUS_M - 10_000) ** 2))

    const draw: TileNode[] = []
    const wanted: TileNode[] = []
    const dist = (n: TileNode) => Math.max(1, Math.hypot(cam.x - n.centre[0], cam.y - n.centre[1], cam.z - n.centre[2]) - n.radius)
    const visible = (n: TileNode) => {
      sphere.center.set(...n.centre)
      sphere.radius = n.radius
      return frustum.intersectsSphere(sphere) && dist(n) <= horizonDist + n.radius
    }
    const wantsRefine = (n: TileNode) => !n.leaf && (vertexSpacingM(n.z) * pxPerRad) / dist(n) > SSE_THRESHOLD_PX

    const visit = (n: TileNode) => {
      n.lastUsed = now
      if (n.state !== 'ready') {
        if (n.state === 'idle') wanted.push(n)
        return false // nothing to draw yet
      }
      if (wantsRefine(n)) {
        const kids = [0, 1].flatMap((dy) => [0, 1].map((dx) => node(n.face, n.z + 1, 2 * n.x + dx, 2 * n.y + dy)))
        const shown = kids.filter(visible)
        for (const k of shown) {
          k.lastUsed = now
          if (k.state === 'idle') wanted.push(k)
        }
        // Switch to the children only once every visible one is ready (no holes).
        if (shown.every((k) => k.state === 'ready' || k.state === 'error') && shown.some((k) => k.state === 'ready')) {
          for (const k of shown) if (k.state === 'ready') visit(k)
          return true
        }
      }
      draw.push(n)
      return true
    }
    for (let f = 0; f < 6; f++) {
      const root = node(f, 0, 0, 0)
      if (visible(root) || root.state !== 'ready') visit(root)
    }

    // Start loads: coarse and near first.
    queue.current = wanted.sort((a, b) => a.z - b.z || dist(a) - dist(b))
    pump()

    // Show exactly the selected meshes.
    const show = new Set(draw.map((n) => n.mesh!))
    let changed = false
    for (const child of [...g.children]) {
      if (!show.has(child as THREE.Mesh)) {
        g.remove(child)
        changed = true
      }
    }
    for (const m of show) {
      if (m.parent !== g) {
        g.add(m)
        changed = true
      }
    }
    if (changed) gl.shadowMap.needsUpdate = true // terrain under the lander may have changed detail

    // Forget meshes not used for a while once the cache is large.
    const ready = [...nodes.current.values()].filter((n) => n.mesh)
    if (ready.length > MAX_CACHED_MESHES) {
      ready
        .filter((n) => now - n.lastUsed > 10_000 && n.z > 1)
        .sort((a, b) => a.lastUsed - b.lastUsed)
        .slice(0, ready.length - MAX_CACHED_MESHES)
        .forEach((n) => {
          n.mesh!.geometry.dispose()
          n.mesh = null
          n.state = 'idle'
        })
    }
    if (PERF_ENABLED) {
      const levels: Record<number, number> = {}
      for (const n of draw) levels[n.z] = (levels[n.z] ?? 0) + 1
      recordTileLevels(levels)
    }
    onStats?.({
      visible: draw.length,
      loading: inFlight.current,
      cached: ready.length,
      deepest: draw.reduce((d, n) => Math.max(d, n.z), 0),
    })
  })

  return (
    <group
      ref={group}
      name="terrain-tiles"
      onClick={
        onPick
          ? (e) => {
              if (e.delta > 4) return // that was an orbit drag, not a click
              e.stopPropagation()
              onPick([e.point.x, e.point.y, e.point.z])
            }
          : undefined
      }
    />
  )
}
