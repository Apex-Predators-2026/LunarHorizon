// Geometry for Google-Earth-style navigation (GlobeControls.tsx). Pure three.js maths, unit-tested.
// The Moon is a sphere around `centre` (the site frame's Moon centre); the camera moves around it.
import * as THREE from 'three'

export interface CameraLike {
  position: THREE.Vector3
  quaternion: THREE.Quaternion
  up: THREE.Vector3
  updateMatrixWorld: () => void
}

const v = new THREE.Vector3()

/** Distance along a ray (unit direction) to the nearest hit on a sphere in front of the origin, or null. */
export function raySphere(origin: THREE.Vector3, dir: THREE.Vector3, centre: THREE.Vector3, radius: number): number | null {
  v.subVectors(origin, centre)
  const b = v.dot(dir)
  const c = v.lengthSq() - radius * radius
  const disc = b * b - c
  if (disc < 0) return null
  const s = Math.sqrt(disc)
  const t0 = -b - s
  const t1 = -b + s
  if (t0 > 0) return t0
  if (t1 > 0) return t1 // inside the sphere
  return null
}

/** Rotate the camera (position, orientation, up) and any extra points about the Moon's centre. */
export function rotateAbout(camera: CameraLike, centre: THREE.Vector3, q: THREE.Quaternion, ...points: THREE.Vector3[]) {
  for (const p of [camera.position, ...points]) p.sub(centre).applyQuaternion(q).add(centre)
  camera.quaternion.premultiply(q)
  camera.up.applyQuaternion(q)
  camera.updateMatrixWorld()
}

/**
 * The rotation about `centre` that brings the surface point now under the pointer (`hit`) back to
 * the point that was grabbed (`grabbed`): applied to the camera, the grabbed point is under the
 * pointer again, i.e. the Moon spins with the cursor.
 */
export function grabRotation(centre: THREE.Vector3, hit: THREE.Vector3, grabbed: THREE.Vector3): THREE.Quaternion {
  const a = hit.clone().sub(centre).normalize()
  const b = grabbed.clone().sub(centre).normalize()
  return new THREE.Quaternion().setFromUnitVectors(a, b)
}

/**
 * Where the pointer ray "touches" a grab sphere of `radius`: the hit itself, or, when the ray
 * passes beside the sphere (pointer off the limb), the ray's closest approach pulled onto the
 * sphere, so dragging past the edge keeps spinning smoothly instead of stopping.
 */
export function grabPoint(ray: THREE.Ray, centre: THREE.Vector3, radius: number): THREE.Vector3 {
  const t = raySphere(ray.origin, ray.direction, centre, radius)
  if (t !== null) return ray.at(t, new THREE.Vector3())
  const closest = ray.closestPointToPoint(centre, new THREE.Vector3())
  return closest.sub(centre).setLength(radius).add(centre)
}

/**
 * Zoom by `factor` (< 1 = closer) towards `focus`: the camera and the look target scale about it,
 * so the focus stays under the pointer and the view direction doesn't change.
 */
export function zoomAbout(camera: CameraLike, target: THREE.Vector3, focus: THREE.Vector3, factor: number) {
  camera.position.sub(focus).multiplyScalar(factor).add(focus)
  target.sub(focus).multiplyScalar(factor).add(focus)
  camera.updateMatrixWorld()
}

/** Rotate the camera (position, orientation, up) by `q` about the point `about`. */
function rotateCameraAbout(camera: CameraLike, about: THREE.Vector3, q: THREE.Quaternion) {
  camera.position.sub(about).applyQuaternion(q).add(about)
  camera.quaternion.premultiply(q)
  camera.up.applyQuaternion(q)
  camera.updateMatrixWorld()
}

/**
 * The plane the camera tilts in about `pivot`: `axis` is the camera's own left-right direction made
 * horizontal at the pivot (tilting about it moves the view straight up/down the screen, so the horizon
 * stays level), `back` the horizontal direction behind the view (where tilting away from straight down
 * takes the camera). Falls back to the camera's offset from above the pivot when the camera is rolled
 * on its side.
 */
function tiltFrame(camera: CameraLike, pivot: THREE.Vector3, centre: THREE.Vector3) {
  const up = pivot.clone().sub(centre).normalize()
  const axis = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion)
  axis.addScaledVector(up, -axis.dot(up))
  if (axis.lengthSq() < 1e-6) {
    axis.crossVectors(up, camera.position.clone().sub(pivot))
    axis.addScaledVector(up, -axis.dot(up))
  }
  if (axis.lengthSq() < 1e-12) return null
  axis.normalize()
  const back = new THREE.Vector3().crossVectors(axis, up)
  return { up, axis, back }
}

/**
 * Turn (heading, about the local vertical at `pivot`) and tilt (towards / away from straight down)
 * the camera around the surface point it is looking at, keeping its distance. The camera's own
 * orientation turns with it (never re-aimed from scratch), so the view can't suddenly roll, even
 * when looking straight down; a level horizon stays level. The tilt is always along the screen
 * (about the camera's left-right direction), whichever way the camera sits off the vertical, so
 * tilting from straight down never comes out sideways (a diagonal horizon).
 * Tilt stays between `minTilt` (looking almost straight down) and `maxTilt` (almost level), radians
 * from the vertical.
 */
export function orbitAbout(
  camera: CameraLike,
  pivot: THREE.Vector3,
  centre: THREE.Vector3,
  dHeading: number,
  dTilt: number,
  minTilt = 0.02,
  maxTilt = (85 * Math.PI) / 180,
) {
  const up = pivot.clone().sub(centre).normalize()
  if (camera.position.distanceTo(pivot) === 0) return
  // Heading: everything turns about the vertical through the pivot.
  if (dHeading) rotateCameraAbout(camera, pivot, new THREE.Quaternion().setFromAxisAngle(up, dHeading))
  // Tilt: about the horizontal axis across the view, clamped. Limits never move the view by
  // themselves: a tilt already outside them is kept, just not pushed further out.
  const frame = tiltFrame(camera, pivot, centre)
  if (!frame || !dTilt) return
  const tilt = tiltIn(frame, camera.position.clone().sub(pivot))
  const next = THREE.MathUtils.clamp(tilt + dTilt, Math.min(minTilt, tilt), Math.max(maxTilt, tilt))
  if (next === tilt) return
  rotateCameraAbout(camera, pivot, new THREE.Quaternion().setFromAxisAngle(frame.axis, next - tilt))
  levelHorizon(camera, centre) // e.g. a view that sat a little sideways of straight above
}

/** The tilt within the tilt plane: 0 straight above, positive behind the view, negative in front. */
function tiltIn(frame: { up: THREE.Vector3; back: THREE.Vector3 }, offset: THREE.Vector3): number {
  return Math.atan2(offset.dot(frame.back), offset.dot(frame.up))
}

/**
 * Roll the camera about its forward axis (the middle of the view stays put) so the horizon is level:
 * its left-right direction horizontal. `amount` (0-1) applies part of it. Nothing happens looking
 * (nearly) straight down or up, where roll means nothing; the correction fades in from 3 to 10 degrees
 * off vertical, so it never spins a near-top-down view round. Returns the roll removed (radians).
 */
export function levelHorizon(camera: CameraLike, centre: THREE.Vector3, amount = 1): number {
  const up = camera.position.clone().sub(centre).normalize()
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion)
  const offVertical = Math.acos(THREE.MathUtils.clamp(Math.abs(forward.dot(up)), 0, 1))
  const weight = amount * THREE.MathUtils.smoothstep(offVertical, (3 * Math.PI) / 180, (10 * Math.PI) / 180)
  if (weight <= 0) return 0
  const level = new THREE.Vector3().crossVectors(forward, up)
  if (level.lengthSq() < 1e-12) return 0
  level.normalize()
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion)
  const roll = Math.atan2(new THREE.Vector3().crossVectors(right, level).dot(forward), right.dot(level))
  if (Math.abs(roll) < 1e-12) return 0
  const q = new THREE.Quaternion().setFromAxisAngle(forward, roll * weight)
  camera.quaternion.premultiply(q)
  camera.up.applyQuaternion(q)
  camera.updateMatrixWorld()
  return roll * weight
}

/**
 * "Straight down" for the top-down toggle: a hair off vertical (~0.2 deg, not visible), so the way the
 * view faces is kept and tilting back later goes back the same way.
 */
export const TOP_DOWN_TILT = 0.003

/**
 * How far the camera is tilted away from straight above `pivot` (0 = looking straight down at it),
 * measured along the screen as orbitAbout tilts (a small sideways offset doesn't count).
 */
export function tiltAt(camera: CameraLike, pivot: THREE.Vector3, centre: THREE.Vector3): number {
  const offset = camera.position.clone().sub(pivot)
  const frame = tiltFrame(camera, pivot, centre)
  if (frame) return tiltIn(frame, offset) // along the screen, as orbitAbout tilts
  const up = pivot.clone().sub(centre).normalize()
  return Math.acos(THREE.MathUtils.clamp(offset.normalize().dot(up), -1, 1))
}

/** Swing the camera about `pivot` to the given tilt (same distance and heading, horizon level). */
export function tiltTo(camera: CameraLike, pivot: THREE.Vector3, centre: THREE.Vector3, tilt: number) {
  orbitAbout(camera, pivot, centre, 0, tilt - tiltAt(camera, pivot, centre), Math.min(tilt, TOP_DOWN_TILT))
}

/**
 * How far the view is pitched up from looking at `pivot` (radians, about the camera's own right-hand
 * axis): 0 when the pivot is in the middle of the view. At eye level the view looks at the horizon,
 * above the ground point the top-down toggle swings about.
 */
export function lookOffset(camera: CameraLike, pivot: THREE.Vector3): number {
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion)
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion)
  const toPivot = pivot.clone().sub(camera.position).normalize()
  forward.addScaledVector(right, -forward.dot(right))
  toPivot.addScaledVector(right, -toPivot.dot(right))
  return Math.atan2(new THREE.Vector3().crossVectors(toPivot, forward).dot(right), toPivot.dot(forward))
}

/** Pitch the view in place (no roll) so that lookOffset(camera, pivot) is `offset`. */
export function setLookOffset(camera: CameraLike, pivot: THREE.Vector3, offset: number) {
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion)
  const turn = offset - lookOffset(camera, pivot)
  if (Math.abs(turn) < 1e-12) return
  camera.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(right, turn))
  camera.updateMatrixWorld()
}

/**
 * Which way the view faces at `pivot`, as a compass heading (radians, clockwise from north): the
 * camera's forward and screen-up directions flattened onto the ground there, so it is defined from a
 * view along the ground to one straight down (then it's the direction at the top of the screen).
 * `axis` = the Moon's spin axis (towards the north pole) in the scene frame. Null at a pole.
 */
export function viewHeading(camera: CameraLike, pivot: THREE.Vector3, centre: THREE.Vector3, axis: THREE.Vector3): number | null {
  const up = pivot.clone().sub(centre).normalize()
  const north = axis.clone().addScaledVector(up, -axis.dot(up))
  if (north.lengthSq() < 1e-12) return null
  north.normalize()
  const east = new THREE.Vector3().crossVectors(north, up)
  const h = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).add(new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion))
  h.addScaledVector(up, -h.dot(up))
  if (h.lengthSq() < 1e-12) return null
  return Math.atan2(h.dot(east), h.dot(north))
}

export const MAX_TILT = (85 * Math.PI) / 180

/**
 * How far from straight down (towards the Moon's centre) the camera may look at a given altitude
 * (m), like Google Earth: no limit near the ground (look at the horizon), less and less higher up,
 * and about straight down from far away, so zooming out or dragging from orbit keeps the Moon in
 * the middle of the view instead of low on the screen.
 */
export function maxNadirAngleAt(altitude: number, low = 30_000, high = 1_000_000): number {
  if (altitude <= low) return Math.PI // no limit
  if (altitude >= high) return (1 * Math.PI) / 180
  const t = Math.log(altitude / low) / Math.log(high / low)
  const from = (100 * Math.PI) / 180
  const to = (1 * Math.PI) / 180
  return from + (to - from) * t
}

/** The surface point the view is centred on: where the camera's forward ray meets the sphere, or,
 * looking past the edge of the Moon, the point on it closest to that ray. */
/**
 * The most a camera `distance` from a surface point (`pivotRadius` from the Moon's centre) may tilt
 * about it (radians from straight above it) and still look within `nadirLimit` of straight down
 * (maxNadirAngleAt). Seen from the camera, tilting by t about the point turns the view only by
 * t - atan(D sin t / (R + D cos t)), so far away a little nadir allowance is a little more tilt.
 */
export function maxTiltForNadir(nadirLimit: number, pivotRadius: number, distance: number): number {
  const nadir = (t: number) => t - Math.atan2(distance * Math.sin(t), pivotRadius + distance * Math.cos(t))
  if (nadir(MAX_TILT) <= nadirLimit) return MAX_TILT
  let lo = 0
  let hi = MAX_TILT
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2
    if (nadir(mid) <= nadirLimit) lo = mid
    else hi = mid
  }
  return lo
}

export function viewPivot(camera: CameraLike, centre: THREE.Vector3, radius: number): THREE.Vector3 {
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion)
  return grabPoint(new THREE.Ray(camera.position.clone(), forward), centre, radius)
}

/** Angle (radians) between where the camera looks and straight down towards the Moon's centre. */
export function nadirAngle(camera: CameraLike, centre: THREE.Vector3): number {
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion)
  const down = centre.clone().sub(camera.position).normalize()
  return Math.acos(THREE.MathUtils.clamp(forward.dot(down), -1, 1))
}

/**
 * Pitch the camera in place until it looks at most `limit` away from straight down. True if it
 * moved. It turns by the smallest rotation that does this (about the axis across the view), so
 * the view never rolls; re-aiming with a "level" up vector would be ill-defined when looking
 * nearly straight down, and flipped the view between horizontal and vertical.
 */
export function limitNadirAngle(camera: CameraLike, centre: THREE.Vector3, limit: number): boolean {
  const angle = nadirAngle(camera, centre)
  if (angle <= limit + 1e-4) return false
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion)
  const down = centre.clone().sub(camera.position).normalize()
  const axis = new THREE.Vector3().crossVectors(forward, down)
  if (axis.lengthSq() < 1e-12) return false // looking straight up: leave it
  const q = new THREE.Quaternion().setFromAxisAngle(axis.normalize(), angle - limit)
  camera.quaternion.premultiply(q)
  camera.up.applyQuaternion(q)
  camera.updateMatrixWorld()
  return true
}

const m = new THREE.Matrix4()
/** Point the camera at `target` using its current `up` (like Object3D.lookAt for a camera). */
export function lookAt(camera: CameraLike, target: THREE.Vector3) {
  m.lookAt(camera.position, target, camera.up)
  camera.quaternion.setFromRotationMatrix(m)
  camera.updateMatrixWorld()
}

/** The object CameraRig and the camera readout talk to (like drei's OrbitControls). */
// Events: 'start' when the user begins a gesture (CameraRig cancels a view flight), 'change' on every move.
export class GlobeNavigation extends THREE.EventDispatcher<{ change: object; start: object }> {
  readonly target = new THREE.Vector3() // the point the camera looks at (on the surface when possible)
  readonly centre = new THREE.Vector3() // the Moon's centre in the site frame
  private readonly camera: THREE.Camera
  constructor(camera: THREE.Camera) {
    super()
    this.camera = camera
  }
  /** Aim the camera at `target` with the horizon level there (used after setting a view preset). */
  update() {
    // Level at the target, except where that is ill-defined (target near the Moon's centre, or
    // looking along the vertical): then keep the camera's current roll rather than jump.
    const forward = this.target.clone().sub(this.camera.position).normalize()
    let up = this.target.distanceTo(this.centre) > 1000 ? this.target.clone().sub(this.centre).normalize() : new THREE.Vector3(0, 1, 0)
    if (Math.abs(up.dot(forward)) > 0.995) up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion)
    this.camera.up.copy(up)
    lookAt(this.camera, this.target)
    this.dispatchEvent({ type: 'change' })
  }
}
