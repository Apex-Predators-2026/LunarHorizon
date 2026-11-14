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
}

const v = new THREE.Vector3()
const n = new THREE.Vector3()

/**
 * Keeps plain DOM labels (rendered outside the <Canvas>, in the same container) pinned to 3D
 * points by projecting them every frame. Used instead of drei <Html>, whose per-label React roots
 * get torn down under React 19 StrictMode.
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
    for (const { ref, position, hideWithinM, hideBeyondM, followCamera, onSurface } of labels) {
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
        const toCam = camera.position.clone().sub(v)
        if (n.dot(toCam) < 0) {
          el.style.display = 'none'
          continue
        }
      }
      v.project(camera)
      const visible = v.z < 1 && Math.abs(v.x) < 1.2 && Math.abs(v.y) < 1.2 // in front of the camera, on screen
      el.style.display = visible ? 'block' : 'none'
      if (visible) {
        const x = ((v.x + 1) / 2) * size.width
        const y = ((1 - v.y) / 2) * size.height
        el.style.transform = `translate(${x}px, ${y}px) translate(-50%, calc(-100% - 14px))`
      }
    }
  })
  return null
}
