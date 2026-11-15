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
import { advanceLoad, initialLoad, useTerrainLoad } from './terrainLoad'
import { imageryMix, imageryWanted, TileImagery } from './tileImagery'
import { useCoverage } from './coverage'
import { retryDelayMs, STALE_REQUEST_MS, TILE_TIMEOUT_MS } from './tileRetry'

/** Request start times for the loading bar (tile loads start from the frame loop, not during render). */
const clockMs = () => performance.now()

// The browser opens at most 6 connections per origin (HTTP/1.1, the Vite proxy and uvicorn), shared
// with the imagery tiles (tileImagery.ts, 2) and the other /api calls. Requests beyond that wait in the
// browser's queue and could time out without ever being sent, so zoomed out (imagery loading too)
// terrain keeps to 4.
const MAX_IN_FLIGHT = 6
const MAX_IN_FLIGHT_WITH_IMAGERY = 4
/** Seen from a camera, terrain up to this high (m, above the sphere) can rise over the horizon. */
const MAX_RELIEF_M = 11_000
const LOWEST_M = 10_000 // ... and the horizon line can graze ground this far below the sphere
/** Nodes without a mesh that nobody visited for this long are forgotten (keeps the map small). */
const PRUNE_AFTER_MS = 60_000
/** Abort reason for a download the view no longer wants (not counted as a failure). */
const STALE = new Error('tile no longer wanted')
// Start downloading the ready-made coarse globe with the page, before the first tile is wanted.
if (typeof window !== 'undefined') void basePack()
const UPDATE_EVERY_MS = 60 // at most this often while the camera moves
const EDGE_MARGIN = 0.12 // tiles up to ~7 deg outside the view count as visible (see visible())
const STICKY_EDGE_MARGIN = 0.4 // ... and up to ~22 deg for tiles that were visible at the last selection

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
  request: AbortController | null // while loading (cancelled when the view no longer wants it)
  refined: boolean // its children were drawn instead of it at the last selection (see MERGE_AT)
  onScreen: boolean // it was visible at the last check (see STICKY_EDGE_MARGIN)
  lastSse: number // its on-screen vertex step at the last selection (px), to tell zooming in from out
}

/**
 * Hysteresis between detail levels: a tile is split into its children once a vertex step spans more
 * than lodThresholdPx on screen, but merged back only below this fraction of it. Without it a tile
 * near the threshold flips between levels while zooming (patches flashing sharper/blurrier), and
 * children that finish loading just after the camera moved on would show for a moment and vanish.
 */
const MERGE_AT = 0.75

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
  tileHeightsRef,
  cameraClearanceM = 3,
  lodThresholdPx = 4,
  maxCachedMeshes = 500,
}: {
  frame: SiteFrame
  material: THREE.Material
  onStats?: (s: TileStats) => void
  onPick?: (point: Vec3) => void // a click on the terrain (not an orbit drag), in the site frame
  tileHeightsRef?: { current: TileHeights | null } // exposes loaded LOLA DEM tile heights for surface profile sampling
  cameraClearanceM?: number // the camera never gets closer than this to the ground below it (m)
  lodThresholdPx?: number // refine while a vertex step spans more than this on screen (graphics preset)
  maxCachedMeshes?: number // tile meshes kept in memory (graphics preset)
}) {
  const group = useRef<THREE.Group>(null)
  const nodes = useRef(new Map<string, TileNode>())
  const inFlight = useRef(0)
  const queue = useRef<TileNode[]>([])
  const lastUpdate = useRef(0)
  const dirty = useRef(true) // a tile arrived (or the site changed) since the last selection
  const warned = useRef(false) // a tile failure has been reported (once per site)
  const requests = useRef(new Map<AbortController, number>()) // in flight (-> start time), cancelled when the site changes
  const retryTimers = useRef(new Set<ReturnType<typeof setTimeout>>())
  const loading = useRef(new Set<TileNode>()) // tiles being downloaded
  const errored = useRef(new Set<TileNode>()) // tiles waiting for a retry
  const failStreak = useRef(0) // failed loads since the last one that worked (an outage, if it grows)
  const maxInFlight = useRef(MAX_IN_FLIGHT)
  const throttleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastPrune = useRef(0)
  // Loading indicators (terrainLoad.ts): finished loads, tiles on screen, oldest request in flight.
  const finished = useRef(0) // tile loads finished for this site
  const drawnCount = useRef(0)
  const publish = () => {
    const pending = inFlight.current + queue.current.filter((q) => q.state === 'idle').length
    const s = useTerrainLoad.getState()
    let waitingSince: number | null = null
    for (const t of requests.current.values()) waitingSince = Math.min(waitingSince ?? t, t)
    const next = advanceLoad(s, { drawn: drawnCount.current, pending, finished: finished.current, waitingSince }, performance.now())
    if (next !== s) useTerrainLoad.setState(next, true)
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
    finished.current = 0
    useTerrainLoad.setState(initialLoad, true) // a new site: "Loading the Moon" until its first tiles draw
    invalidate()
    const pending = requests.current
    const timers = retryTimers.current
    const inLoad = loading.current
    const failed = errored.current
    return () => {
      for (const c of pending.keys()) c.abort() // don't keep the connections busy with the old site's tiles
      pending.clear()
      for (const t of timers) clearTimeout(t)
      timers.clear()
      inLoad.clear()
      failed.clear()
      failStreak.current = 0
      for (const n of map.values()) if (n.mesh) disposeTile(n.mesh)
      map.clear()
      queue.current = []
    }
  }, [frame, invalidate])

  // Back online (or the backend answered again after an outage, see load()): retry failed tiles now
  // instead of after their backoff, so a blurry area sharpens as soon as data can come.
  const wakeFailed = () => {
    const now = performance.now()
    for (const n of errored.current) n.retryAt = Math.min(n.retryAt, now)
    dirty.current = true
    invalidate()
  }
  useEffect(() => {
    const onOnline = () => wakeFailed()
    window.addEventListener('online', onOnline)
    return () => {
      window.removeEventListener('online', onOnline)
      if (throttleTimer.current) clearTimeout(throttleTimer.current)
      throttleTimer.current = null
    }
  })

  // LRO imagery when zoomed out (tileImagery.ts), a fresh one per site and terrain material.
  useEffect(() => {
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
  }, [material, frame, get, invalidate])

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
      n = { key, face: f, z, x, y, state: 'idle', leaf: z >= MAX_ZOOM, centre, radius, mesh: null, heights: null, lastUsed: 0, failures: 0, retryAt: 0, request: null, refined: false, onScreen: false, lastSse: 0 }
      nodes.current.set(key, n)
    }
    return n
  }

  /** Is this node still the one the tree holds under its key (not an old site's, nor a pruned one)? */
  const current = (n: TileNode) => nodes.current.get(n.key) === n

  const load = (n: TileNode) => {
    n.state = 'loading'
    inFlight.current++
    loading.current.add(n)
    const ctl = new AbortController()
    n.request = ctl
    requests.current.set(ctl, clockMs())
    let timeout: ReturnType<typeof setTimeout> | undefined
    basePack()
      .then(async (pack): Promise<Float32Array> => {
        // The coarsest levels ship with the page (globe/basePack.ts): no request at all.
        const local = pack?.get(n.key)
        if (local) {
          n.leaf = local.leaf || n.z >= MAX_ZOOM
          return local.heights
        }
        if (ctl.signal.aborted) throw ctl.signal.reason
        // The clock starts when the request is made, not while waiting for the base pack.
        timeout = setTimeout(() => ctl.abort(new Error(`tile ${n.key}: no answer in ${TILE_TIMEOUT_MS / 1000} s`)), TILE_TIMEOUT_MS)
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
        if (!current(n)) return // site changed meanwhile
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
        errored.current.delete(n)
        // The first answer after several failures: the backend is back, retry the others now.
        if (failStreak.current >= 2) wakeFailed()
        failStreak.current = 0
      })
      .catch((e: unknown) => {
        if (!current(n)) return // site changed (its requests were cancelled)
        if (ctl.signal.aborted && ctl.signal.reason === STALE) {
          n.state = 'idle' // the view moved on: not a failure, asked for again if wanted later
          return
        }
        n.state = 'error'
        n.failures++
        failStreak.current++
        errored.current.add(n)
        // Never give up for good: a tile that gave up would keep its whole area coarse for the rest of
        // the session (its parent is drawn until every visible child is ready). Back off up to 30 s.
        const delay = retryDelayMs(n.failures)
        n.retryAt = performance.now() + delay
        // With on-demand rendering nothing would look at it again: wake the selection up.
        const t = setTimeout(() => {
          retryTimers.current.delete(t)
          dirty.current = true
          invalidate()
        }, delay + 20)
        retryTimers.current.add(t)
        // Say why once per site (a silent failure here means no terrain and no clue).
        if (!warned.current) {
          warned.current = true
          console.warn('Terrain tile failed to load; the terrain may be incomplete.', e)
        }
      })
      .finally(() => {
        clearTimeout(timeout)
        requests.current.delete(ctl)
        loading.current.delete(n)
        if (n.request === ctl) n.request = null
        inFlight.current--
        finished.current++
        pump() // keep the connections busy between selections
        publish()
        dirty.current = true // reselect on the next frame
        invalidate()
      })
  }

  /** Start queued loads (from the last selection) up to MAX_IN_FLIGHT, skipping stale entries. */
  const pump = () => {
    while (inFlight.current < maxInFlight.current && queue.current.length) {
      const n = queue.current.shift()!
      if (n.state === 'idle' && current(n)) load(n)
    }
  }

  const tileHeights: TileHeights = (f, z, x, y) => nodes.current.get(keyOf(f, z, x, y))?.heights ?? undefined
  useEffect(() => {
    if (tileHeightsRef) tileHeightsRef.current = tileHeights
  })

  useFrame((state) => {
    // Runs after GlobeControls (zoom easing at priority -1) has moved the camera, before this frame renders.
    const c = state.camera.position
    const lifted = liftAboveGround([c.x, c.y, c.z], frame, tileHeights, cameraClearanceM)
    if (lifted) {
      c.set(...lifted)
      state.camera.updateMatrixWorld()
    }
    // Photo mosaic by altitude: updated every frame, so the fade follows the zoom smoothly.
    const cm = frame.toMoon([c.x, c.y, c.z])
    const altitude = Math.hypot(cm[0], cm[1], cm[2]) - MOON_RADIUS_M
    const mix = imageryMix(altitude)
    maxInFlight.current = imageryWanted(altitude) ? MAX_IN_FLIGHT_WITH_IMAGERY : MAX_IN_FLIGHT
    if (imageryRef.current?.tick(performance.now(), mix)) invalidate() // a tile is fading in
    const mixPct = Math.round(mix * 100)
    if (useCoverage.getState().mixPct !== mixPct) useCoverage.setState({ mixPct }) // the coverage badge
    if (PERF_ENABLED) {
      const m = cm
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
      // Come back once the throttle allows (otherwise an idle canvas would never reselect), with one
      // timer rather than a frame every frame until then.
      throttleTimer.current ??= setTimeout(() => {
        throttleTimer.current = null
        invalidate()
      }, UPDATE_EVERY_MS - (now - lastUpdate.current) + 1)
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
    // Horizon culling: from the camera, nothing beyond the Moon's limb is visible. The line of sight
    // grazes the limb (at worst ground LOWEST_M below the sphere), then rises again: a peak up to
    // MAX_RELIEF_M high is still seen up to farSide beyond it. From a lander ~200 km of horizon plus
    // ~260 km, which covers the engine's 300 km horizon mask (so the 3D skyline has the same ridges).
    const mc = frame.moonCentre
    const dc = Math.hypot(cam.x - mc[0], cam.y - mc[1], cam.z - mc[2])
    const low = MOON_RADIUS_M - LOWEST_M
    const farSide = Math.sqrt((MOON_RADIUS_M + MAX_RELIEF_M) ** 2 - low * low)
    const horizonDist = Math.sqrt(Math.max(0, dc * dc - low * low)) + farSide

    const draw: TileNode[] = []
    const wanted: TileNode[] = []
    const dist = (n: TileNode) => Math.max(1, Math.hypot(cam.x - n.centre[0], cam.y - n.centre[1], cam.z - n.centre[2]) - n.radius)
    const visible = (n: TileNode) => {
      sphere.center.set(...n.centre)
      // A margin around the screen: the camera keeps moving between selections (UPDATE_EVERY_MS), so
      // tiles just outside the view are drawn too, or the edge it uncovers would be a hole meanwhile.
      // Tiles already on screen get a wider one, so a quick swing (e.g. levelling out while zooming
      // out fast) doesn't drop them for a moment only to need them again at the next selection.
      sphere.radius = n.radius + dist(n) * (n.onScreen ? STICKY_EDGE_MARGIN : EDGE_MARGIN)
      n.onScreen = frustum.intersectsSphere(sphere) && dist(n) <= horizonDist + n.radius
      return n.onScreen
    }
    /** Split this tile into its children? sse = on-screen size of one vertex step (px). */
    const wantsRefine = (n: TileNode) => {
      if (n.leaf) return false
      const sse = (vertexSpacingM(n.z) * pxPerRad) / dist(n)
      // Getting smaller on screen (zooming out / moving away): don't switch to children that only
      // just arrived, they would be merged away again a moment later (a patch flashing sharp).
      const receding = sse < n.lastSse * 0.98
      n.lastSse = sse
      return n.refined ? sse > lodThresholdPx * MERGE_AT : sse > lodThresholdPx && !receding
    }

    let retrying = 0
    /** A failed tile whose wait is over is requested again. */
    const due = (n: TileNode) => {
      if (n.state !== 'error') return
      retrying++
      if (now >= n.retryAt) {
        n.state = 'idle'
        errored.current.delete(n)
      }
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
        // Load all four children, also those just off screen: one that slides into view later is then
        // ready, instead of making the whole patch fall back to this coarser tile until it loads.
        for (const k of kids) {
          k.lastUsed = now
          due(k)
          if (k.state === 'idle') wanted.push(k)
        }
        const shown = kids.filter(visible)
        // Switch to the children only once every visible one is ready: a child that failed keeps
        // its parent drawn (coarser, but no hole) until a retry succeeds.
        if (shown.length && shown.every((k) => k.state === 'ready')) {
          n.refined = true
          for (const k of shown) visit(k)
          return true
        }
      }
      n.refined = false
      draw.push(n)
      return true
    }
    for (let f = 0; f < 6; f++) {
      const root = node(f, 0, 0, 0)
      if (visible(root) || root.state !== 'ready') visit(root)
    }

    // Downloads for tiles this view no longer reaches (a quick move from globe to site, say) give their
    // connection to the tiles it does want. The backend still finishes and caches them.
    for (const n of loading.current)
      if (n.request && now - n.lastUsed > STALE_REQUEST_MS && n.z > 0) n.request.abort(STALE)

    // Start loads: a hole first (a whole face with nothing to draw), then what is on screen, then the
    // tiles that look coarsest there (largest on-screen vertex step).
    const sse = (n: TileNode) => vertexSpacingM(n.z) / dist(n)
    queue.current = wanted.sort(
      (a, b) => Number(b.z === 0) - Number(a.z === 0) || Number(b.onScreen) - Number(a.onScreen) || sse(b) - sse(a),
    )
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
    // Imagery only when zoomed out far enough for it to show (no requests close up).
    if (imageryWanted(altitude))
      imageryRef.current?.apply(
        draw.map((n) => ({ key: n.key, face: n.face, z: n.z, x: n.x, y: n.y, mesh: n.mesh! })),
        material,
        now,
      )
    else
      imageryRef.current?.release(
        draw.map((n) => n.mesh!),
        material,
      )

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
    // Forget empty nodes nobody visited for a while (they would otherwise pile up while exploring).
    if (now - lastPrune.current > 5_000) {
      lastPrune.current = now
      for (const [key, n] of nodes.current)
        if (!n.mesh && n.z > 1 && n.state !== 'loading' && now - n.lastUsed > PRUNE_AFTER_MS) {
          nodes.current.delete(key)
          errored.current.delete(n)
        }
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
