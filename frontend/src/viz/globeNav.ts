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

/**
 * Turn (heading, about the local vertical at `pivot`) and tilt (towards / away from straight down)
 * the camera around a point on the surface, keeping its distance and the horizon level.
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
  const offset = camera.position.clone().sub(pivot)
  const dist = offset.length()
  if (dist === 0) return
  // Heading: spin the offset about the vertical.
  offset.applyAxisAngle(up, dHeading)
  // Tilt: angle between the offset and the vertical, clamped.
  const tilt = Math.acos(THREE.MathUtils.clamp(offset.clone().normalize().dot(up), -1, 1))
  const next = THREE.MathUtils.clamp(tilt + dTilt, minTilt, maxTilt)
  const side = new THREE.Vector3().crossVectors(up, offset)
  if (side.lengthSq() < 1e-12) side.set(1, 0, 0).cross(up) // straight above: any horizontal axis
  offset.applyAxisAngle(side.normalize(), next - tilt)
  camera.position.copy(pivot).add(offset.setLength(dist))
  camera.up.copy(up)
  lookAt(camera, pivot)
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
 * Pitch the camera in place (same position, horizon level) until it looks at most `limit` away
 * from straight down. True if it moved.
 */
export function limitNadirAngle(camera: CameraLike, centre: THREE.Vector3, limit: number): boolean {
  const angle = nadirAngle(camera, centre)
  if (angle <= limit + 1e-4) return false
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion)
  const down = centre.clone().sub(camera.position).normalize()
  const axis = new THREE.Vector3().crossVectors(forward, down)
  if (axis.lengthSq() < 1e-12) return false // looking straight up: leave it
  forward.applyAxisAngle(axis.normalize(), angle - limit)
  camera.up.copy(down).negate()
  lookAt(camera, camera.position.clone().add(forward))
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
export class GlobeNavigation extends THREE.EventDispatcher<{ change: object }> {
  readonly target = new THREE.Vector3() // the point the camera looks at (on the surface when possible)
  readonly centre = new THREE.Vector3() // the Moon's centre in the site frame
  private readonly camera: THREE.Camera
  constructor(camera: THREE.Camera) {
    super()
    this.camera = camera
  }
  /** Aim the camera at `target` with the horizon level there (used after setting a view preset). */
  update() {
    const up = this.target.distanceTo(this.centre) > 1 ? this.target.clone().sub(this.centre).normalize() : new THREE.Vector3(0, 1, 0)
    this.camera.up.copy(up)
    lookAt(this.camera, this.target)
    this.dispatchEvent({ type: 'change' })
  }
}
