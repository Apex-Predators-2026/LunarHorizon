// Streaming, level-of-detail terrain for the whole Moon (cube-sphere quadtree).
// Tiles come from /api/terrain/tile (backend/app/terrain_router.py), are built in the site frame
// (see SiteFrame) and refined until each vertex step covers < lodThresholdPx (default 4) px on screen.
// Works with frameloop="demand": tile selection only runs when the camera moved or a tile arrived,
// and the shadow map is only redrawn when the set of drawn tiles changes.
// It also keeps the camera above the ground: after the camera controls move it, a camera that would
// be closer than cameraClearanceM to the loaded terrain below it is lifted straight up.
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { API_URL } from '../api'
import { PERF_ENABLED, recordCameraClearance, recordTileBuild, recordTileLevels } from '../perf'
import { MAX_ZOOM, MOON_RADIUS_M, SiteFrame, TILE_N, tileVertexUV, uvToVec, vertexSpacingM, type Vec3 } from './cubeSphere'
import { groundHeightAt, liftAboveGround, type TileHeights } from './terrainHeight'
import { buildTileMesh, innerHeights, tilePadding, tileTopology } from './tileGeometry'
import { basePack } from './basePack'
import { useTerrainLoad } from './terrainLoad'
import { TileImagery } from './tileImagery'
import { MAX_TILE_ATTEMPTS, retryDelayMs, TILE_TIMEOUT_MS } from './tileRetry'

const MAX_IN_FLIGHT = 6
// Start downloading the ready-made coarse globe with the page, before the first tile is wanted.
if (typeof window !== 'undefined') void basePack()
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
  heights: Float32Array | null // kept while the mesh is, for ground-height lookups
  lastUsed: number
  failures: number // failed attempts so far (reset when it loads)
  retryAt: number // performance.now() after which a failed tile may be requested again
}

export interface TileStats {
  visible: number
  loading: number
  cached: number
  deepest: number
  retrying: number // tiles that failed and are waiting to be retried (their area shows coarser terrain)
}

const keyOf = (f: number, z: number, x: number, y: number) => `${f}/${z}/${x}/${y}`

// Scratch objects for the per-frame selection (one TileTree per scene).
const frustum = new THREE.Frustum()
const projView = new THREE.Matrix4()
const sphere = new THREE.Sphere()
const lastView = new THREE.Matrix4() // camera at the last selection
const lastProj = new THREE.Matrix4()

// Every tile has the same triangles and texture coordinates, so all tiles share one index buffer
// and one uv buffer (each uploaded to the GPU once).
let sharedIndex: THREE.BufferAttribute | null = null
let sharedUv: THREE.BufferAttribute | null = null
const tileIndex = () => (sharedIndex ??= new THREE.BufferAttribute(tileTopology(TILE_N).indices, 1))
const tileUv = () => (sharedUv ??= new THREE.BufferAttribute(tileTopology(TILE_N).uvs, 2))
const PAD = 1 // tiles come with a ring of their neighbours' vertices, for seamless normals

/** Free a tile's GPU buffers, but not the shared index and uvs (other tiles still draw with them). */
function disposeTile(mesh: THREE.Mesh) {
  mesh.geometry.setIndex(null)
  mesh.geometry.deleteAttribute('uv')
  mesh.geometry.dispose()
}

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
  cameraClearanceM = 3,
  lodThresholdPx = 4,
  maxCachedMeshes = 500,
  imagery = false,
}: {
  frame: SiteFrame
  material: THREE.Material
  onStats?: (s: TileStats) => void
  onPick?: (point: Vec3) => void // a click on the terrain (not an orbit drag), in the site frame
  cameraClearanceM?: number // the camera never gets closer than this to the ground below it (m)
  lodThresholdPx?: number // refine while a vertex step spans more than this on screen (graphics preset)
  maxCachedMeshes?: number // tile meshes kept in memory (graphics preset)
  imagery?: boolean // drape the LRO WAC mosaic over the terrain (see tileImagery.ts)
}) {
  const group = useRef<THREE.Group>(null)
  const nodes = useRef(new Map<string, TileNode>())
  const inFlight = useRef(0)
  const queue = useRef<TileNode[]>([])
  const lastUpdate = useRef(0)
  const dirty = useRef(true) // a tile arrived (or the site changed) since the last selection
  const warned = useRef(false) // a tile failure has been reported (once per site)
  const requests = useRef(new Set<AbortController>()) // in flight, cancelled when the site changes
  const retryTimers = useRef(new Set<ReturnType<typeof setTimeout>>())
  // Loading bar: tiles finished in the current burst (since tiles started being needed again).
  const burstDone = useRef(0)
  const drawnCount = useRef(0)
  const publish = () => {
    const pending = inFlight.current + queue.current.filter((q) => q.state === 'idle').length
    const s = useTerrainLoad.getState()
    if (s.pending === 0 && pending > 0) burstDone.current = 0 // a new burst
    const next = { drawn: drawnCount.current, pending, done: burstDone.current, total: burstDone.current + pending }
    if (next.drawn !== s.drawn || next.pending !== s.pending || next.done !== s.done || next.total !== s.total) useTerrainLoad.setState(next)
  }
  const lastSize = useRef('')
  const camera = useThree((s) => s.camera)
  const size = useThree((s) => s.size)
  const invalidate = useThree((s) => s.invalidate)
  const get = useThree((s) => s.get)
  const imageryRef = useRef<TileImagery | null>(null)

  // A different site means a different frame: drop everything.
  useEffect(() => {
    const map = nodes.current
    dirty.current = true
    warned.current = false
    drawnCount.current = 0
    useTerrainLoad.setState({ drawn: 0 }) // a new site: "Loading the Moon" until its first tiles draw
    invalidate()
    const pending = requests.current
    const timers = retryTimers.current
    return () => {
      for (const c of pending) c.abort() // don't keep the connections busy with the old site's tiles
      pending.clear()
      for (const t of timers) clearTimeout(t)
      timers.clear()
      for (const n of map.values()) if (n.mesh) disposeTile(n.mesh)
      map.clear()
      queue.current = []
    }
  }, [frame, invalidate])

  // Imagery layer on/off (and a fresh one per site): reapply materials on the next frame.
  useEffect(() => {
    if (!imagery) return
    const reselect = () => {
      dirty.current = true
      invalidate()
    }
    const im = new TileImagery(reselect, Math.min(8, get().gl.capabilities.getMaxAnisotropy()))
    imageryRef.current = im
    reselect()
    const map = nodes.current
    return () => {
      im.dispose(
        [...map.values()].flatMap((n) => (n.mesh ? [n.mesh] : [])),
        material,
      )
      imageryRef.current = null
      reselect()
    }
  }, [imagery, material, frame, get, invalidate])

  // A different detail level: reselect on the next frame.
  useEffect(() => {
    dirty.current = true
    invalidate()
  }, [lodThresholdPx, invalidate])

  const node = (f: number, z: number, x: number, y: number): TileNode => {
    const key = keyOf(f, z, x, y)
    let n = nodes.current.get(key)
    if (!n) {
      const [centre, radius] = approxBounds(frame, f, z, x, y)
      n = { key, face: f, z, x, y, state: 'idle', leaf: z >= MAX_ZOOM, centre, radius, mesh: null, heights: null, lastUsed: 0, failures: 0, retryAt: 0 }
      nodes.current.set(key, n)
    }
    return n
  }

  const load = (n: TileNode) => {
    n.state = 'loading'
    inFlight.current++
    const ctl = new AbortController()
    requests.current.add(ctl)
    const timeout = setTimeout(() => ctl.abort(new Error(`tile ${n.key}: no answer in ${TILE_TIMEOUT_MS / 1000} s`)), TILE_TIMEOUT_MS)
    basePack()
      .then(async (pack): Promise<Float32Array> => {
        // The coarsest levels ship with the page (globe/basePack.ts): no request at all.
        const local = pack?.get(n.key)
        if (local) {
          n.leaf = local.leaf || n.z >= MAX_ZOOM
          return local.heights
        }
        const res = await fetch(`${API_URL}/api/terrain/tile/${n.face}/${n.z}/${n.x}/${n.y}?pad=${PAD}`, { signal: ctl.signal })
        if (!res.ok) throw new Error(`tile ${n.key}: HTTP ${res.status}`)
        n.leaf = res.headers.get('X-Tile-Leaf') === '1' || n.z >= MAX_ZOOM
        return new Float32Array(await res.arrayBuffer())
      })
      .then((heights) => {
        // A backend from before padding ignores ?pad=1 and sends the plain tile: draw that too
        // (its edges get one-sided normals) rather than no terrain at all.
        const pad = tilePadding(heights.length)
        if (pad === null) throw new Error(`tile ${n.key}: ${heights.length} heights, expected ${(TILE_N + 2) ** 2} or ${TILE_N ** 2}`)
        if (!nodes.current.has(n.key)) return // site changed meanwhile
        const t0 = performance.now()
        const m = buildTileMesh(n.face, n.z, n.x, n.y, heights, frame, TILE_N, pad)
        const geom = new THREE.BufferGeometry()
        geom.setAttribute('position', new THREE.BufferAttribute(m.positions, 3))
        geom.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3))
        geom.setIndex(tileIndex())
        geom.setAttribute('uv', tileUv())
        geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), m.radius) // known: skip three's pass
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
        n.heights = innerHeights(heights, TILE_N, pad)
        n.failures = 0
        n.state = 'ready'
      })
      .catch((e: unknown) => {
        if (!nodes.current.has(n.key)) return // site changed (its requests were cancelled)
        n.state = 'error'
        n.failures++
        if (n.failures < MAX_TILE_ATTEMPTS) {
          const delay = retryDelayMs(n.failures)
          n.retryAt = performance.now() + delay
          // With on-demand rendering nothing would look at it again: wake the selection up.
          const t = setTimeout(() => {
            retryTimers.current.delete(t)
            dirty.current = true
            invalidate()
          }, delay + 20)
          retryTimers.current.add(t)
        }
        // Say why once per site (a silent failure here means no terrain and no clue).
        if (!warned.current) {
          warned.current = true
          console.warn('Terrain tile failed to load; the terrain may be incomplete.', e)
        }
      })
      .finally(() => {
        clearTimeout(timeout)
        requests.current.delete(ctl)
        inFlight.current--
        burstDone.current++
        pump() // keep the connections busy between selections
        publish()
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

  const tileHeights: TileHeights = (f, z, x, y) => nodes.current.get(keyOf(f, z, x, y))?.heights ?? undefined

  useFrame((state) => {
    // Runs after GlobeControls (zoom easing at priority -1) has moved the camera, before this frame renders.
    const c = state.camera.position
    const lifted = liftAboveGround([c.x, c.y, c.z], frame, tileHeights, cameraClearanceM)
    if (lifted) {
      c.set(...lifted)
      state.camera.updateMatrixWorld()
    }
    if (PERF_ENABLED) {
      const m = frame.toMoon([c.x, c.y, c.z])
      const h = groundHeightAt(m, tileHeights)
      recordCameraClearance(h === null ? null : Math.hypot(m[0], m[1], m[2]) - MOON_RADIUS_M - h)
    }

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
    const wantsRefine = (n: TileNode) => !n.leaf && (vertexSpacingM(n.z) * pxPerRad) / dist(n) > lodThresholdPx

    let retrying = 0
    /** A failed tile whose wait is over is requested again (until MAX_TILE_ATTEMPTS). */
    const due = (n: TileNode) => {
      if (n.state !== 'error') return
      retrying++
      if (n.failures < MAX_TILE_ATTEMPTS && now >= n.retryAt) n.state = 'idle'
    }
    const visit = (n: TileNode) => {
      n.lastUsed = now
      due(n)
      if (n.state !== 'ready') {
        if (n.state === 'idle') wanted.push(n)
        return false // nothing to draw yet
      }
      if (wantsRefine(n)) {
        const kids = [0, 1].flatMap((dy) => [0, 1].map((dx) => node(n.face, n.z + 1, 2 * n.x + dx, 2 * n.y + dy)))
        const shown = kids.filter(visible)
        for (const k of shown) {
          k.lastUsed = now
          due(k)
          if (k.state === 'idle') wanted.push(k)
        }
        // Switch to the children only once every visible one is ready: a child that failed keeps
        // its parent drawn (coarser, but no hole) until a retry succeeds.
        if (shown.length && shown.every((k) => k.state === 'ready')) {
          for (const k of shown) visit(k)
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
    if (changed) state.gl.shadowMap.needsUpdate = true
    imageryRef.current?.apply(
      draw.map((n) => ({ key: n.key, face: n.face, z: n.z, x: n.x, y: n.y, mesh: n.mesh! })),
      material,
      now,
    ) // terrain under the lander may have changed detail

    // Forget meshes not used for a while once the cache is large.
    const ready = [...nodes.current.values()].filter((n) => n.mesh)
    if (ready.length > maxCachedMeshes) {
      ready
        .filter((n) => now - n.lastUsed > 10_000 && n.z > 1)
        .sort((a, b) => a.lastUsed - b.lastUsed)
        .slice(0, ready.length - maxCachedMeshes)
        .forEach((n) => {
          imageryRef.current?.forget(n.key)
          disposeTile(n.mesh!)
          n.mesh = null
          n.heights = null
          n.state = 'idle'
        })
    }
    if (PERF_ENABLED) {
      const levels: Record<number, number> = {}
      for (const n of draw) levels[n.z] = (levels[n.z] ?? 0) + 1
      recordTileLevels(levels)
    }
    drawnCount.current = draw.length
    publish()
    onStats?.({
      visible: draw.length,
      loading: inFlight.current,
      cached: ready.length,
      deepest: draw.reduce((d, n) => Math.max(d, n.z), 0),
      retrying,
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
