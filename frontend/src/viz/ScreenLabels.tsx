import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, type RefObject } from 'react'
import * as THREE from 'three'

export interface ScreenLabel {
  ref: RefObject<HTMLElement | null>
  position: [number, number, number] | null // world position, or null to hide
  hideWithinM?: number // hide while the camera is closer than this to the scene origin (the lander)
  hideBeyondM?: number // hide while the camera is farther than this from the label's point
  followCamera?: boolean // position is relative to the camera (for things inside <FollowCamera>)
  onSurface?: boolean // a point on the Moon: hide it when it's on the far side (needs moonCentre)
  declutter?: boolean // hide it while it would overlap a label already shown (e.g. crowded site names)
}

const v = new THREE.Vector3()
const n = new THREE.Vector3()
const toCam = new THREE.Vector3()

const LIFT_PX = 14 // labels sit this far above their point (see the transform below)
const GAP_PX = 2
// Rendered label sizes, measured once per text (reading layout every frame would be slow).
const sizes = new WeakMap<HTMLElement, { w: number; h: number; text: string }>()

interface OnScreen {
  el: HTMLElement
  x: number
  y: number
  declutter: boolean
}

/**
 * Keeps plain DOM labels (rendered outside the <Canvas>, in the same container) pinned to 3D
 * points by projecting them every frame. Used instead of drei <Html>, whose per-label React roots
 * get torn down under React 19 StrictMode.
 *
 * Labels without `declutter` are always shown. Labels with it are placed afterwards, in order, and
 * skipped while they would overlap one already placed, so a crowded area (all the south-polar
 * sites seen from orbit) shows a few readable names instead of a pile; zooming in reveals the rest.
 */
export function ScreenLabels({
  labels,
  moonCentre,
}: {
  labels: ScreenLabel[]
  moonCentre?: [number, number, number] | null
}) {
  // Labels are positioned in useFrame; with frameloop="demand", ask for a frame whenever the
  // labels (or their text, rendered by the same parent) change.
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => invalidate())

  useFrame(({ camera, size }) => {
    const onScreen: OnScreen[] = []
    for (const { ref, position, hideWithinM, hideBeyondM, followCamera, onSurface, declutter } of labels) {
      const el = ref.current
      if (!el) continue
      if (!position || (hideWithinM !== undefined && camera.position.length() < hideWithinM)) {
        el.style.display = 'none'
        continue
      }
      v.set(...position)
      if (followCamera) v.add(camera.position)
      if (hideBeyondM !== undefined && v.distanceTo(camera.position) > hideBeyondM) {
        el.style.display = 'none'
        continue
      }
      // Far side of the Moon: the surface normal at the point faces away from the camera.
      if (onSurface && moonCentre) {
        n.set(v.x - moonCentre[0], v.y - moonCentre[1], v.z - moonCentre[2])
        toCam.copy(camera.position).sub(v)
        if (n.dot(toCam) < 0) {
          el.style.display = 'none'
          continue
        }
      }
      v.project(camera)
      if (!(v.z < 1 && Math.abs(v.x) < 1.2 && Math.abs(v.y) < 1.2)) {
        el.style.display = 'none' // behind the camera or off screen
        continue
      }
      onScreen.push({ el, x: ((v.x + 1) / 2) * size.width, y: ((1 - v.y) / 2) * size.height, declutter: !!declutter })
    }

    // Place the fixed labels first, then the declutterable ones where they fit.
    const placed: [number, number, number, number][] = []
    const toMeasure: HTMLElement[] = []
    for (const pass of [false, true]) {
      for (const p of onScreen) {
        if (p.declutter !== pass) continue
        const text = p.el.textContent ?? ''
        let s = sizes.get(p.el)
        if (!s || s.text !== text) {
          s = { w: 6.5 * text.length + 14, h: 20, text } // estimate until measured
          toMeasure.push(p.el)
        }
        const r: [number, number, number, number] = [p.x - s.w / 2, p.y - s.h - LIFT_PX, p.x + s.w / 2, p.y - LIFT_PX]
        const overlaps = placed.some((q) => r[0] < q[2] + GAP_PX && r[2] + GAP_PX > q[0] && r[1] < q[3] + GAP_PX && r[3] + GAP_PX > q[1])
        if (pass && overlaps) {
          p.el.style.display = 'none'
          continue
        }
        placed.push(r)
        p.el.style.display = 'block'
        p.el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, calc(-100% - ${LIFT_PX}px))`
      }
    }
    // Measure newly shown labels once (after all writes: one layout), then redo this frame's
    // placement with the real sizes.
    let measured = false
    for (const el of toMeasure) {
      if (el.style.display !== 'block') continue
      sizes.set(el, { w: el.offsetWidth, h: el.offsetHeight, text: el.textContent ?? '' })
      measured = true
    }
    if (measured) invalidate()
  })
  return null
}
