import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { MOON_RADIUS_M, SiteFrame, TILE_N, tileAt, type Vec3 } from './cubeSphere'
import { groundHeightAt, liftAboveGround, tileSurfaceHeight, type TileHeights } from './terrainHeight'
import { buildTileMesh } from './tileGeometry'

const N = TILE_N
const frame = new SiteFrame(-89.53432, 209.94767, 1654) // Connecting Ridge
const radialHeight = (p: Vec3) => Math.hypot(...frame.toMoon(p)) - MOON_RADIUS_M

// Deterministic bumpy heights (+-60 m) so every quad is non-planar.
const bumpy = (seed: number) =>
  Float32Array.from({ length: N * N }, (_, k) => 1654 + 60 * Math.sin(k * 12.9898 + seed) * Math.cos(k * 0.37))

describe('tile surface height', () => {
  it('reproduces a plane exactly', () => {
    const h = Float32Array.from({ length: N * N }, (_, k) => 2 * (k % N) + 3 * Math.floor(k / N))
    expect(tileSurfaceHeight(h, 10.25, 7.75)).toBeCloseTo(2 * 10.25 + 3 * 7.75, 4)
    expect(tileSurfaceHeight(h, 63.9, 0.1)).toBeCloseTo(2 * 63.9 + 3 * 0.1, 4)
  })

  it('uses the same diagonal as the mesh', () => {
    const h = new Float32Array(N * N)
    h[N + 1] = 10 // quad (0,0) with only its (1,1) corner raised
    expect(tileSurfaceHeight(h, 0.5, 0.5)).toBeCloseTo(5) // on the shared diagonal
    expect(tileSurfaceHeight(h, 0.75, 0.25)).toBeCloseTo(2.5) // triangle (0,0)-(1,0)-(1,1)
    expect(tileSurfaceHeight(h, 0.25, 0.75)).toBeCloseTo(2.5) // triangle (0,0)-(1,1)-(0,1)
  })
})

describe('ground height under a point', () => {
  const [f, x, y] = tileAt(frame.latDeg, frame.lonDeg, 13)
  const fine = bumpy(1)
  const tiles: TileHeights = (face, z, tx, ty) =>
    face === f && z === 13 && tx === x && ty === y ? fine : z === 0 ? new Float32Array(N * N).fill(100) : undefined

  it('matches the drawn tile mesh (ray cast straight down)', () => {
    const m = buildTileMesh(f, 13, x, y, fine, frame)
    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.BufferAttribute(m.positions, 3))
    geom.setIndex(new THREE.BufferAttribute(m.indices.subarray(0, m.surfaceIndexCount), 1))
    const mesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }))
    mesh.position.set(...m.centre)
    mesh.updateMatrixWorld()
    const ray = new THREE.Raycaster()
    const c = frame.moonCentre
    // Points spread over the tile (~330 m across, not aligned with east/north), within 160 m of its centre.
    for (const [dx, dz] of [[0, 0], [37.3, -81.9], [-95.5, 60.2], [90.1, 85.7], [-80.8, -95.3]]) {
      const px = m.centre[0] + dx
      const pz = m.centre[2] + dz
      const top = new THREE.Vector3(px, 3000, pz)
      ray.set(top, new THREE.Vector3(c[0] - px, c[1] - 3000, c[2] - pz).normalize())
      const hit = ray.intersectObject(mesh)[0]
      expect(hit).toBeDefined()
      const want = radialHeight([hit.point.x, hit.point.y, hit.point.z])
      // Query the ray's own column (away from the site, site-frame "down" isn't quite radial).
      expect(groundHeightAt(frame.toMoon([px, 3000, pz]), tiles)).toBeCloseTo(want, 2)
    }
  })

  it('uses the finest loaded tile, and says when nothing is loaded', () => {
    expect(groundHeightAt(frame.toMoon([0, 0, 0]), tiles)).not.toBe(100) // the z13 tile, not z0
    expect(groundHeightAt(frame.toMoon([50_000, 0, 0]), tiles)).toBeCloseTo(100) // only z0 there
    expect(groundHeightAt(frame.toMoon([0, 0, 0]), () => undefined)).toBeNull()
  })
})

describe('keeping the camera above ground', () => {
  const flat: TileHeights = () => new Float32Array(N * N).fill(1654) // the site's own ground height

  it('lifts a camera that is below the clearance straight up', () => {
    const lifted = liftAboveGround([10, -50, 20], frame, flat, 3)!
    expect(radialHeight(lifted) - 1654).toBeCloseTo(3, 3)
    // Straight up: the same direction from the Moon's centre, so the same lat/lon.
    const a = frame.toMoon([10, -50, 20])
    const b = frame.toMoon(lifted)
    const cos = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(...a) * Math.hypot(...b))
    expect(cos).toBeCloseTo(1, 12)
  })

  it('leaves a camera that is high enough, far away, or over unloaded terrain alone', () => {
    expect(liftAboveGround([0, 10, 0], frame, flat, 3)).toBeNull()
    expect(liftAboveGround([0, 6_000_000, 0], frame, flat, 3)).toBeNull()
    expect(liftAboveGround([0, -50, 0], frame, () => undefined, 3)).toBeNull()
  })
})
