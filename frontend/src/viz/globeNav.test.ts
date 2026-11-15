import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import {
  grabPoint,
  grabRotation,
  levelHorizon,
  limitNadirAngle,
  lookAt,
  lookOffset,
  maxNadirAngleAt,
  maxTiltForNadir,
  nadirAngle,
  orbitAbout,
  raySphere,
  rotateAbout,
  setLookOffset,
  tiltAt,
  tiltTo,
  TOP_DOWN_TILT,
  viewHeading,
  zoomAbout,
} from './globeNav'

const R = 1_737_400
const centre = new THREE.Vector3(0, -R, 0) // like the site frame: the Moon's centre straight below the site

function camera(pos: [number, number, number], target: THREE.Vector3) {
  const c = new THREE.PerspectiveCamera(50, 16 / 9, 0.5, 1e9)
  c.position.set(...pos)
  lookAt(c, target)
  return c
}
const rayAt = (c: THREE.Camera, x: number, y: number) => {
  const r = new THREE.Raycaster()
  r.setFromCamera(new THREE.Vector2(x, y), c)
  return r.ray
}
const distanceToRay = (ray: THREE.Ray, p: THREE.Vector3) => ray.distanceToPoint(p)

describe('globe navigation', () => {
  it('finds where a ray meets the Moon', () => {
    const c = camera([0, 6e6, 0], centre)
    const t = raySphere(c.position, rayAt(c, 0, 0).direction, centre, R)
    expect(t).toBeCloseTo(6e6, 0) // straight down onto the site
    expect(raySphere(c.position, new THREE.Vector3(1, 0, 0), centre, R)).toBeNull() // looking away
  })

  it('keeps the grabbed point under the cursor while dragging (the Moon spins with it)', () => {
    const c = camera([0, 4e6, 3e6], centre)
    const d0 = c.position.distanceTo(centre)
    const grabbed = grabPoint(rayAt(c, 0.1, -0.2), centre, R)
    // Pointer positions on the Moon's disc (it spans about +-15 deg of the 50 deg view here).
    for (const [x, y] of [[0.15, -0.05], [0.2, 0.15], [-0.1, 0.2]]) {
      const hit = grabPoint(rayAt(c, x, y), centre, R)
      rotateAbout(c, centre, grabRotation(centre, hit, grabbed))
      // The grabbed surface point is under the pointer again, and still on the Moon.
      expect(distanceToRay(rayAt(c, x, y), grabbed)).toBeLessThan(1) // metres, at millions of m
    }
    // Spinning, not moving: the camera stays the same distance from the Moon's centre.
    expect(c.position.distanceTo(centre)).toBeCloseTo(d0, -1)
  })

  it('keeps spinning smoothly when the pointer leaves the Moon (past the limb)', () => {
    const c = camera([0, 6e6, 0], centre)
    const off = grabPoint(rayAt(c, 0.99, 0), centre, R)
    expect(off.distanceTo(centre)).toBeCloseTo(R, 0) // pulled onto the sphere, not lost
  })

  it('zooms towards the point under the cursor without turning the view', () => {
    const target = centre.clone()
    const c = camera([0, 4e6, 3e6], target)
    const ray = rayAt(c, 0.3, 0.2)
    const focus = ray.at(raySphere(ray.origin, ray.direction, centre, R)!, new THREE.Vector3())
    const before = c.quaternion.clone()
    zoomAbout(c, target, focus, 0.5)
    expect(distanceToRay(rayAt(c, 0.3, 0.2), focus)).toBeLessThan(1e-3 * focus.distanceTo(c.position))
    expect(c.quaternion.angleTo(before)).toBeLessThan(1e-6)
  })

  it('turns and tilts around a surface point, keeping the distance and the horizon level', () => {
    const pivot = new THREE.Vector3(0, 0, 0) // the site, on the surface
    const c = camera([2000, 1500, 3000], pivot)
    const d = c.position.distanceTo(pivot)
    orbitAbout(c, pivot, centre, 0.5, 0.2)
    expect(c.position.distanceTo(pivot)).toBeCloseTo(d, 6)
    // Can't tilt below the horizon or past straight down.
    orbitAbout(c, pivot, centre, 0, 10)
    const tilt = Math.acos(c.position.clone().sub(pivot).normalize().dot(new THREE.Vector3(0, 1, 0)))
    expect(tilt).toBeLessThanOrEqual((85 * Math.PI) / 180 + 1e-9)
    orbitAbout(c, pivot, centre, 0, -10)
    expect(c.position.y).toBeGreaterThan(0.99 * d)
    // Horizon level: the camera's right vector is horizontal (no roll).
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(c.quaternion)
    expect(Math.abs(right.y)).toBeLessThan(1e-6)
  })
})

describe('view limit by altitude (Moon centred when zoomed out)', () => {
  it('leaves near-ground views free and allows only about straight down from far away', () => {
    expect(maxNadirAngleAt(5_000)).toBe(Math.PI)
    const mid = [100e3, 300e3, 1000e3].map((a) => maxNadirAngleAt(a))
    expect(mid[0]).toBeGreaterThan(mid[1])
    expect(mid[1]).toBeGreaterThan(mid[2])
    expect(maxNadirAngleAt(3_000_000)).toBeLessThan(0.02)
  })

  it('pitches a far camera that looks past the Moon back to the Moon, in place and level', () => {
    // 5,000 km up, looking out over the limb (as after zooming out from a horizon view).
    const c = camera([0, 5e6, 0], new THREE.Vector3(0, 5e6, -4e6))
    const before = c.position.clone()
    expect(limitNadirAngle(c, centre, maxNadirAngleAt(5e6))).toBe(true)
    expect(c.position.equals(before)).toBe(true)
    expect((nadirAngle(c, centre) * 180) / Math.PI).toBeLessThan(1.1) // the Moon in the middle
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(c.quaternion)
    expect(Math.abs(right.dot(c.position.clone().sub(centre).normalize()))).toBeLessThan(1e-6) // horizon level
  })

  it('never rolls the view when straightening it near straight down (no horizontal/vertical flip)', () => {
    for (const roll of [0, 0.7, 1.6, 2.9]) {
      // 900 km up, looking 5 deg off straight down, with some roll about the view axis.
      const pos = new THREE.Vector3(0, 9e5, 0)
      const lookPoint = centre.clone().add(new THREE.Vector3(0.09 * 2.6e6, 0, 0))
      const c = camera([pos.x, pos.y, pos.z], lookPoint)
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(c.quaternion)
      c.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(fwd, roll))
      const rightBefore = new THREE.Vector3(1, 0, 0).applyQuaternion(c.quaternion)
      const off = nadirAngle(c, centre)
      limitNadirAngle(c, centre, (1 * Math.PI) / 180)
      const rightAfter = new THREE.Vector3(1, 0, 0).applyQuaternion(c.quaternion)
      // The right-hand direction turns by no more than the straightening itself.
      expect(rightBefore.angleTo(rightAfter)).toBeLessThanOrEqual(off + 1e-6)
    }
  })

  it('leaves a low view of the horizon alone', () => {
    const c = camera([0, 50, 0], new THREE.Vector3(0, 50, -5000)) // eye level, looking level
    const q = c.quaternion.clone()
    expect(limitNadirAngle(c, centre, maxNadirAngleAt(50))).toBe(false)
    expect(c.quaternion.equals(q)).toBe(true)
  })
})

describe('top-down toggle (look straight down, and back)', () => {
  it('swings a tilted site view to straight down over the same point, at the same distance, and back again', () => {
    const pivot = new THREE.Vector3(0, 0, 0) // the lander, in the middle of the view
    const c = camera([2600, 1400, 3400], pivot) // the Site view preset
    const start = c.position.clone()
    const before = tiltAt(c, pivot, centre)
    expect(before).toBeGreaterThan(1) // ~72 deg from straight down: looking across the ground
    const d = c.position.distanceTo(pivot)

    tiltTo(c, pivot, centre, TOP_DOWN_TILT)
    expect(tiltAt(c, pivot, centre)).toBeCloseTo(TOP_DOWN_TILT, 6)
    expect(c.position.distanceTo(pivot)).toBeCloseTo(d, 3)
    expect(nadirAngle(c, centre)).toBeLessThan(0.01) // looking straight down
    expect(distanceToRay(rayAt(c, 0, 0), pivot)).toBeLessThan(0.01) // the same point is still in the middle
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(c.quaternion)
    expect(Math.abs(right.y)).toBeLessThan(1e-6) // no roll

    tiltTo(c, pivot, centre, before) // and back to the tilt it had
    expect(c.position.distanceTo(start)).toBeLessThan(0.01)
  })

  it('moves in small steps for the animation (each step from where the last one left off)', () => {
    const pivot = new THREE.Vector3(0, 0, 0)
    const c = camera([2600, 1400, 3400], pivot)
    const from = tiltAt(c, pivot, centre)
    for (let k = 1; k <= 10; k++) tiltTo(c, pivot, centre, from + (TOP_DOWN_TILT - from) * (k / 10))
    expect(tiltAt(c, pivot, centre)).toBeCloseTo(TOP_DOWN_TILT, 6)
  })
})

describe('top-down toggle at eye level (the Sun and Earth views)', () => {
  it('looks straight down at the ground just ahead, then back to exactly the view it had', () => {
    // 12 m up, looking at the horizon (slightly above level), like the Sun view.
    const c = camera([45, 12, -3], new THREE.Vector3(-4955, 100, 300))
    const start = { pos: c.position.clone(), q: c.quaternion.clone() }
    const ahead = new THREE.Vector3(-4955, 0, 300).sub(new THREE.Vector3(45, 0, -3)).normalize()
    const pivot = new THREE.Vector3(45, 0, -3).addScaledVector(ahead, 60) // on the ground, 60 m ahead
    const tilt0 = tiltAt(c, pivot, centre)
    const off0 = lookOffset(c, pivot)
    expect(off0).toBeGreaterThan(0.2) // the view is well above the pivot

    // The animation: tilt and look offset together, in steps.
    for (let k = 1; k <= 20; k++) {
      const e = k / 20
      tiltTo(c, pivot, centre, tilt0 + (TOP_DOWN_TILT - tilt0) * e)
      setLookOffset(c, pivot, off0 * (1 - e))
    }
    expect(nadirAngle(c, centre)).toBeLessThan(0.01) // straight down
    expect(distanceToRay(rayAt(c, 0, 0), pivot)).toBeLessThan(0.01) // at the spot ahead

    for (let k = 1; k <= 20; k++) {
      const e = k / 20
      tiltTo(c, pivot, centre, TOP_DOWN_TILT + (tilt0 - TOP_DOWN_TILT) * e)
      setLookOffset(c, pivot, off0 * e)
    }
    expect(c.position.distanceTo(start.pos)).toBeLessThan(0.01)
    expect(c.quaternion.angleTo(start.q)).toBeLessThan(1e-6)
  })

  it('measures no offset when the pivot is in the middle of the view', () => {
    const pivot = new THREE.Vector3(0, 0, 0)
    const c = camera([2600, 1400, 3400], pivot)
    expect(Math.abs(lookOffset(c, pivot))).toBeLessThan(1e-9)
  })
})

describe('fly to a point (minimap click)', () => {
  it('spins the Moon in steps until the clicked point is in the middle of the view, keeping the height', () => {
    const pivot = new THREE.Vector3(0, 0, 0)
    const c = camera([2600, 1400, 3400], pivot)
    const height = c.position.distanceTo(centre)
    // A point ~300 km away on the surface (site frame, the Moon's centre straight below the site).
    const dir = new THREE.Vector3(Math.sin(0.17), Math.cos(0.17), 0)
    const target = centre.clone().addScaledVector(dir, R)
    const total = grabRotation(centre, pivot, target)
    const applied = new THREE.Quaternion()
    for (let k = 1; k <= 12; k++) {
      const now = new THREE.Quaternion().slerp(total, k / 12)
      rotateAbout(c, centre, now.clone().multiply(applied.clone().invert()))
      applied.copy(now)
    }
    expect(distanceToRay(rayAt(c, 0, 0), target)).toBeLessThan(0.5)
    expect(c.position.distanceTo(centre)).toBeCloseTo(height, 3)
  })
})

describe('top-down toggle turns the view to north-up (tilting along north-south)', () => {
  // The test frame is the site frame of a site near the south pole: x east, y up, z south.
  const lat = (-89.5 * Math.PI) / 180
  const axis = new THREE.Vector3(0, Math.sin(lat), -Math.cos(lat)) // towards the north pole, in the site frame

  it('reads the heading of a view (the Site preset looks north-west)', () => {
    const pivot = new THREE.Vector3(0, 0, 0)
    const c = camera([2600, 1400, 3400], pivot)
    const h = viewHeading(c, pivot, centre, axis)!
    expect((h * 180) / Math.PI).toBeCloseTo((Math.atan2(-2600, 3400) * 180) / Math.PI, 1) // ~ -37 deg
  })

  it('turning by the heading about the vertical brings north to the top; tilting back then looks north', () => {
    const pivot = new THREE.Vector3(0, 0, 0)
    const c = camera([2600, 1400, 3400], pivot)
    const tilt0 = tiltAt(c, pivot, centre)
    const turn = viewHeading(c, pivot, centre, axis)!
    // The swing down, in steps: turn and tilt together.
    let turned = 0
    for (let k = 1; k <= 20; k++) {
      const e = k / 20
      orbitAbout(c, pivot, centre, turn * e - turned, 0)
      turned = turn * e
      tiltTo(c, pivot, centre, tilt0 + (TOP_DOWN_TILT - tilt0) * e)
    }
    expect(nadirAngle(c, centre)).toBeLessThan(0.01)
    expect(Math.abs(viewHeading(c, pivot, centre, axis)!)).toBeLessThan(1e-6) // north at the top of the screen
    const screenUp = new THREE.Vector3(0, 1, 0).applyQuaternion(c.quaternion)
    expect(screenUp.z).toBeLessThan(-0.99) // site frame north is -z
    // Tilt back: the camera comes down on the south side, looking north.
    for (let k = 1; k <= 20; k++) tiltTo(c, pivot, centre, TOP_DOWN_TILT + (tilt0 - TOP_DOWN_TILT) * (k / 20))
    expect(c.position.z).toBeGreaterThan(1000) // south of the lander
    expect(Math.abs(c.position.x)).toBeLessThan(1)
    expect(Math.abs(viewHeading(c, pivot, centre, axis)!)).toBeLessThan(1e-6) // facing north
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(c.quaternion)
    expect(Math.abs(right.y)).toBeLessThan(1e-6) // horizon level
  })
})

describe('right-drag tilt from far away (no fighting with the zoomed-out view limit)', () => {
  it('allows only the tilt that keeps the view within the altitude limit', () => {
    const pivot = new THREE.Vector3(0, 0, 0)
    // The Globe view: straight down from ~4,300 km (screen-up = north, so the view is well defined).
    const c = new THREE.PerspectiveCamera(50, 16 / 9, 0.5, 1e9)
    c.position.set(0, 4_273_000, 0)
    c.up.set(0, 0, -1)
    lookAt(c, pivot)
    const limit = maxNadirAngleAt(4_273_000)
    const maxTilt = maxTiltForNadir(limit, R, 4_273_000)
    expect(maxTilt).toBeGreaterThan(limit) // far away, the tilt about the surface can be a bit more
    expect(maxTilt).toBeLessThan((10 * Math.PI) / 180) // ... but only a few degrees
    orbitAbout(c, pivot, centre, 0, 1, 0.02, maxTilt) // try to tilt a lot
    expect(nadirAngle(c, centre)).toBeLessThanOrEqual(limit + 1e-6)
    expect(distanceToRay(rayAt(c, 0, 0), pivot)).toBeLessThan(1) // still looking at the same point
    expect(c.position.distanceTo(centre) - R).toBeGreaterThan(4_200_000) // no dive towards the surface
  })

  it('leaves near-ground tilting free', () => {
    expect(maxTiltForNadir(maxNadirAngleAt(5_000), R, 5_000)).toBeCloseTo((85 * Math.PI) / 180, 9)
  })
})

describe('right-drag tilt keeps the horizon level (no sideways tilt)', () => {
  const pivot = new THREE.Vector3(0, 0, 0)
  const rightOf = (c: THREE.Camera) => new THREE.Vector3(1, 0, 0).applyQuaternion(c.quaternion)
  /** Straight down from 3 km with north at the top of the screen, a little off to the east of the pivot. */
  function topDownOffSideways() {
    const c = new THREE.PerspectiveCamera(50, 16 / 9, 0.5, 1e9)
    c.position.set(60, 3000, 0) // 0.02 rad east of straight above (as after zooming in towards the cursor): sideways on the screen
    c.up.set(0, 0, -1) // north up
    lookAt(c, pivot)
    return c
  }

  it('tilts towards the bottom of the screen whatever way the camera sits off the vertical', () => {
    const c = topDownOffSideways()
    orbitAbout(c, pivot, centre, 0, 0.6, 0.02)
    // Before: tilting swung the camera further east (sideways on the screen), so the horizon came out diagonal.
    expect(Math.abs(rightOf(c).y)).toBeLessThan(1e-6) // horizon level
    expect(c.position.z).toBeGreaterThan(1500) // came down on the south side (screen-down), looking north
    expect(tiltAt(c, pivot, centre)).toBeCloseTo(0.6, 2)
    expect(distanceToRay(rayAt(c, 0, 0), pivot)).toBeLessThan(0.01) // same point in the middle
  })

  it('tilts along the screen with a rolled top-down view too (after spinning the Moon around)', () => {
    const c = new THREE.PerspectiveCamera(50, 16 / 9, 0.5, 1e9)
    c.position.set(0, 3000, 0)
    c.up.set(Math.sin(1), 0, -Math.cos(1)) // screen-up ~57 deg east of north
    lookAt(c, pivot)
    const screenDown = new THREE.Vector3(0, -1, 0).applyQuaternion(c.quaternion)
    orbitAbout(c, pivot, centre, 0, 0.8, 0.02)
    expect(Math.abs(rightOf(c).y)).toBeLessThan(1e-6)
    const moved = c.position.clone().setY(0).normalize()
    expect(moved.dot(screenDown.setY(0).normalize())).toBeGreaterThan(0.999) // straight down the screen
  })

  it('does not flip over the top when dragging the other way from straight down', () => {
    const c = topDownOffSideways()
    tiltTo(c, pivot, centre, TOP_DOWN_TILT)
    const before = c.position.clone()
    orbitAbout(c, pivot, centre, 0, -0.5, Math.min(0.02, tiltAt(c, pivot, centre)))
    expect(c.position.distanceTo(before)).toBeLessThan(1) // already as straight down as it goes
  })

  it('levelHorizon takes the roll out of a tilted view, about the middle of the view', () => {
    const c = new THREE.PerspectiveCamera(50, 16 / 9, 0.5, 1e9)
    c.position.set(0, 1500, 3000)
    c.up.set(0.5, 1, 0).normalize() // rolled ~27 deg
    lookAt(c, pivot)
    expect(Math.abs(rightOf(c).y)).toBeGreaterThan(0.2)
    levelHorizon(c, centre)
    expect(Math.abs(rightOf(c).y)).toBeLessThan(1e-6)
    expect(new THREE.Vector3(0, 1, 0).applyQuaternion(c.quaternion).y).toBeGreaterThan(0) // upright, not upside down
    expect(distanceToRay(rayAt(c, 0, 0), pivot)).toBeLessThan(0.01)
  })

  it('levelHorizon leaves a straight-down view alone (roll means nothing there)', () => {
    const c = topDownOffSideways()
    c.position.set(0, 3000, 0)
    c.up.set(1, 0, 0)
    lookAt(c, pivot)
    const q = c.quaternion.clone()
    levelHorizon(c, centre)
    expect(c.quaternion.angleTo(q)).toBeLessThan(1e-9)
  })
})
