// Google-Earth-style camera controls for the Moon (replaces OrbitControls).
//   * Left-drag: grab the Moon. The point under the cursor follows the cursor and the Moon spins
//     about its own centre, so it stays where it is on screen; close up, this slides the ground.
//     Let go while moving and it keeps spinning for a moment, slowing down (like Google Earth).
//   * Right-drag (or Ctrl / Shift + left-drag): turn and tilt around the point you're looking at.
//   * Wheel / two-finger pinch: smooth zoom towards the point under the cursor, faster when far.
//   * At eye level (the Sun / Earth views), dragging looks around in place instead.
//   * The higher up, the less the view may tilt (straight down from far away), so zooming out or
//     dragging from orbit keeps the Moon centred instead of low on the screen (as in Google Earth).
// Registered as the scene's default controls, with the `target` + `update()` that CameraRig's
// view presets and the camera readout use. Geometry: globeNav.ts (unit-tested).
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import type { Vec3 } from './globe/cubeSphere'
import { PERF_ENABLED } from './perf'
import {
  GlobeNavigation,
  grabPoint,
  grabRotation,
  limitNadirAngle,
  lookAt,
  maxNadirAngleAt,
  orbitAbout,
  raySphere,
  rotateAbout,
  viewPivot,
  zoomAbout,
} from './globeNav'

const TURN_RAD_PER_PX = 0.005
const ZOOM_PER_WHEEL_PX = 0.0015 // log-scale zoom per wheel pixel (100 px notch ~ 14%)
const ZOOM_EASE = 0.3 // fraction of the remaining zoom applied per frame (smooth, not instant)
const EYE_LEVEL_M = 200 // below this height, dragging looks around instead of grabbing the ground
const MIN_FOCUS_DISTANCE_M = 2
const SPIN_DECAY_MS = 220 // after a flick, the Moon keeps spinning and slows down over about this long
const MAX_SPIN_COAST_RAD = 0.5 // at most about this much extra turn after letting go

type Mode =
  | { kind: 'grab'; grabbed: THREE.Vector3; radius: number }
  | { kind: 'orbit'; pivot: THREE.Vector3 }
  | { kind: 'look' }
  | { kind: 'pinch'; focus: THREE.Vector3; distance: number }

export function GlobeControls({
  moonCentre,
  groundRadius,
  maxDistance,
}: {
  moonCentre: Vec3 | null
  groundRadius: number // the Moon's radius at the site (m): the grab sphere when no terrain is hit
  maxDistance: number // furthest the camera may get from the Moon's surface (m)
}) {
  const get = useThree((s) => s.get)
  const set = useThree((s) => s.set)
  const invalidate = useThree((s) => s.invalidate)
  const nav = useRef<GlobeNavigation | null>(null)
  const zoom = useRef<{ focus: THREE.Vector3; remaining: number } | null>(null)
  const spin = useRef<{ axis: THREE.Vector3; rate: number; last: number; maxStep: number } | null>(null) // rad/ms
  const limits = useRef({ groundRadius, maxDistance })

  useEffect(() => {
    limits.current = { groundRadius, maxDistance }
  }, [groundRadius, maxDistance])

  useEffect(() => {
    if (nav.current && moonCentre) {
      nav.current.centre.set(...moonCentre)
      invalidate()
    }
  }, [moonCentre, invalidate])

  useEffect(() => {
    const { camera, gl, scene } = get()
    const n = new GlobeNavigation(camera)
    if (moonCentre) n.centre.set(...moonCentre)
    nav.current = n
    set({ controls: n })
    if (PERF_ENABLED) (window as unknown as { __nav?: unknown }).__nav = { camera, nav: n } // dev checks (?perf)
    const el = gl.domElement
    const raycaster = new THREE.Raycaster()
    const pointers = new Map<number, { x: number; y: number }>()
    let mode: Mode | null = null
    let last = { x: 0, y: 0 }
    // How fast the Moon is being spun by the current drag (smoothed), for the flick on release.
    let velocity: { axis: THREE.Vector3; rate: number; at: number } | null = null

    const changed = () => {
      n.dispatchEvent({ type: 'change' })
      invalidate()
    }
    const ndcOf = (x: number, y: number) => {
      const r = el.getBoundingClientRect()
      return new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1)
    }
    const rayAt = (x: number, y: number) => {
      raycaster.setFromCamera(ndcOf(x, y), camera)
      return raycaster.ray.clone()
    }
    /** The terrain point under the screen position, else the point on the site-radius sphere. */
    const pick = (x: number, y: number): THREE.Vector3 | null => {
      raycaster.setFromCamera(ndcOf(x, y), camera)
      const tiles = scene.getObjectByName('terrain-tiles')
      const hit = tiles ? raycaster.intersectObject(tiles, true)[0] : undefined
      if (hit) return hit.point.clone()
      const t = raySphere(raycaster.ray.origin, raycaster.ray.direction, n.centre, limits.current.groundRadius)
      return t === null ? null : raycaster.ray.at(t, new THREE.Vector3())
    }
    const altitude = () => camera.position.distanceTo(n.centre) - limits.current.groundRadius
    const screenOf = (p: THREE.Vector3) => {
      const s = p.clone().project(camera)
      const r = el.getBoundingClientRect()
      return { x: r.left + ((s.x + 1) / 2) * r.width, y: r.top + ((1 - s.y) / 2) * r.height }
    }

    /** Where the middle of the view is on screen (the camera's forward axis; the lens shift moves it). */
    const viewCentreOnScreen = () => {
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion)
      return screenOf(camera.position.clone().addScaledVector(forward, 1000))
    }
    /** The surface point in the middle of the view (terrain if loaded there, else the sphere). */
    const viewCentrePoint = () => {
      const at = viewCentreOnScreen()
      return pick(at.x, at.y) ?? viewPivot(camera, n.centre, limits.current.groundRadius)
    }

    /** Pitch the view towards straight down as far as this altitude requires (Moon centred). */
    const relevel = () => {
      if (limitNadirAngle(camera, n.centre, maxNadirAngleAt(altitude()))) {
        n.target.copy(viewPivot(camera, n.centre, limits.current.groundRadius))
      }
    }

    const onDown = (e: PointerEvent) => {
      n.dispatchEvent({ type: 'start' }) // the user takes over (e.g. stops a view flight)
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      el.setPointerCapture(e.pointerId)
      zoom.current = null // a new gesture stops any zoom still easing in or spin still going
      spin.current = null
      velocity = null
      last = { x: e.clientX, y: e.clientY }
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()]
        const focus = pick((a.x + b.x) / 2, (a.y + b.y) / 2) ?? n.target.clone()
        mode = { kind: 'pinch', focus, distance: Math.hypot(a.x - b.x, a.y - b.y) }
        return
      }
      const turn = e.button === 1 || e.button === 2 || e.ctrlKey || e.shiftKey
      if (altitude() < EYE_LEVEL_M) {
        mode = { kind: 'look' }
      } else if (turn) {
        mode = { kind: 'orbit', pivot: viewCentrePoint() }
      } else {
        const grabbed = pick(e.clientX, e.clientY) ?? grabPoint(rayAt(e.clientX, e.clientY), n.centre, limits.current.groundRadius)
        mode = { kind: 'grab', grabbed, radius: grabbed.distanceTo(n.centre) }
      }
      el.style.cursor = 'grabbing'
    }

    const onMove = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId) || !mode) return
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      const dx = e.clientX - last.x
      const dy = e.clientY - last.y
      last = { x: e.clientX, y: e.clientY }
      if (mode.kind === 'pinch') {
        if (pointers.size < 2) return
        const [a, b] = [...pointers.values()]
        const d = Math.hypot(a.x - b.x, a.y - b.y)
        if (d > 0) zoomBy(mode.focus, mode.distance / d)
        mode.distance = d
      } else if (mode.kind === 'grab') {
        const hit = grabPoint(rayAt(e.clientX, e.clientY), n.centre, mode.radius)
        const q = grabRotation(n.centre, hit, mode.grabbed)
        // Cap each step in proportion to the height, so a drag near the horizon can't fling the
        // view hundreds of km (from orbit the cap doesn't bite).
        const maxAngle = Math.min(0.5, (2 * Math.max(altitude(), 1)) / mode.radius)
        const angle = 2 * Math.acos(THREE.MathUtils.clamp(Math.abs(q.w), -1, 1))
        if (angle > maxAngle) q.slerp(new THREE.Quaternion(), 1 - maxAngle / angle)
        rotateAbout(camera, n.centre, q, n.target)
        // No re-levelling while dragging: it would slide the grabbed point away from the cursor.
        const now = performance.now()
        const step = 2 * Math.acos(THREE.MathUtils.clamp(Math.abs(q.w), -1, 1))
        if (step > 1e-9) {
          const axis = new THREE.Vector3(q.x, q.y, q.z).normalize().multiplyScalar(Math.sign(q.w) || 1)
          const dt = velocity ? Math.max(1, now - velocity.at) : 16
          const rate = step / dt
          velocity = velocity
            ? { axis: velocity.axis.multiplyScalar(0.5).addScaledVector(axis, 0.5).normalize(), rate: velocity.rate * 0.5 + rate * 0.5, at: now }
            : { axis, rate, at: now }
        }
        changed()
      } else if (mode.kind === 'orbit') {
        orbitAbout(camera, mode.pivot, n.centre, -dx * TURN_RAD_PER_PX, -dy * TURN_RAD_PER_PX)
        n.target.copy(mode.pivot)
        relevel()
        changed()
      } else {
        // Look around in place: heading about the local vertical, pitch about the camera's right.
        const up = camera.position.clone().sub(n.centre).normalize()
        const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion)
        forward.applyAxisAngle(up, dx * TURN_RAD_PER_PX * 0.6)
        const right = new THREE.Vector3().crossVectors(forward, up).normalize()
        const pitched = forward.clone().applyAxisAngle(right, dy * TURN_RAD_PER_PX * 0.6)
        if (Math.abs(pitched.dot(up)) < 0.98) forward.copy(pitched)
        const dist = Math.max(10, n.target.distanceTo(camera.position))
        n.target.copy(camera.position).addScaledVector(forward, dist)
        camera.up.copy(up)
        lookAt(camera, n.target)
        changed()
      }
    }

    const onUp = (e: PointerEvent) => {
      // A flick: released while still moving, so keep spinning and slow down.
      if (mode?.kind === 'grab' && pointers.size === 1 && velocity && performance.now() - velocity.at < 60) {
        spin.current = {
          axis: velocity.axis.clone(),
          rate: Math.min(velocity.rate, MAX_SPIN_COAST_RAD / SPIN_DECAY_MS), // coast = rate x decay time
          last: performance.now(),
          maxStep: Math.min(0.5, (2 * Math.max(altitude(), 1)) / mode.radius),
        }
        invalidate()
      }
      velocity = null
      pointers.delete(e.pointerId)
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
      if (pointers.size === 0) {
        mode = null
        el.style.cursor = 'grab'
      } else if (pointers.size === 1) {
        // Lifting one finger of a pinch: carry on as a drag from where the other finger is.
        const [p] = [...pointers.values()]
        last = p
        const grabbed = pick(p.x, p.y) ?? grabPoint(rayAt(p.x, p.y), n.centre, limits.current.groundRadius)
        mode = { kind: 'grab', grabbed, radius: grabbed.distanceTo(n.centre) }
      }
    }

    /** Zoom by `factor` (<1 closer) about `focus`, within the near/far limits. */
    const zoomBy = (focus: THREE.Vector3, factor: number) => {
      const toFocus = camera.position.distanceTo(focus)
      if (factor < 1 && toFocus * factor < MIN_FOCUS_DISTANCE_M) factor = MIN_FOCUS_DISTANCE_M / Math.max(toFocus, 1e-6)
      const far = limits.current.groundRadius + limits.current.maxDistance
      const after = camera.position.clone().sub(focus).multiplyScalar(factor).add(focus)
      if (factor > 1 && after.distanceTo(n.centre) > far) {
        const now = camera.position.distanceTo(n.centre)
        if (now >= far) return
        factor = 1 + (factor - 1) * Math.max(0, (far - now) / (after.distanceTo(n.centre) - now))
      }
      zoomAbout(camera, n.target, focus, factor)
      relevel()
      changed()
    }

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      n.dispatchEvent({ type: 'start' })
      const px = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1)
      // In: towards the cursor. Out: away from the view's centre, so the Moon doesn't drift sideways.
      let focus: THREE.Vector3
      spin.current = null
      if (px > 0) {
        focus = viewCentrePoint()
      } else {
        focus = pick(e.clientX, e.clientY) ?? grabPoint(rayAt(e.clientX, e.clientY), n.centre, limits.current.groundRadius)
      }
      const pending = zoom.current
      zoom.current = { focus, remaining: (pending?.remaining ?? 0) + px * ZOOM_PER_WHEEL_PX }
      invalidate()
    }
    const onContextMenu = (e: Event) => e.preventDefault()

    el.style.cursor = 'grab'
    el.style.touchAction = 'none'
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('contextmenu', onContextMenu)
    zoomStep.current = zoomBy
    return () => {
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('contextmenu', onContextMenu)
      el.style.cursor = ''
      zoomStep.current = null
      if (get().controls === n) set({ controls: null })
      nav.current = null
    }
    // moonCentre is applied by its own effect; recreating the controls would drop the target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [get, set, invalidate])

  // Ease wheel zoom over a few frames (runs before TileTree keeps the camera above the ground).
  const zoomStep = useRef<((focus: THREE.Vector3, factor: number) => void) | null>(null)
  useFrame(({ camera }) => {
    const sp = spin.current
    const n = nav.current
    if (sp && n) {
      const now = performance.now()
      const dt = Math.min(50, now - sp.last)
      sp.last = now
      const angle = Math.min(sp.rate * dt, sp.maxStep)
      rotateAbout(camera, n.centre, new THREE.Quaternion().setFromAxisAngle(sp.axis, angle), n.target)
      n.dispatchEvent({ type: 'change' })
      sp.rate *= Math.exp(-dt / SPIN_DECAY_MS)
      if (sp.rate * 16 < 1e-7) spin.current = null
      else invalidate()
    }
    const z = zoom.current
    if (!z || !zoomStep.current) return
    const step = Math.abs(z.remaining) < 1e-3 ? z.remaining : z.remaining * ZOOM_EASE
    zoomStep.current(z.focus, Math.exp(step))
    z.remaining -= step
    if (Math.abs(z.remaining) < 1e-6) zoom.current = null
    else invalidate()
  }, -1)

  return null
}
