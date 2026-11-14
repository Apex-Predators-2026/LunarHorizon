import { useFrame } from '@react-three/fiber'
import type { RefObject } from 'react'
import * as THREE from 'three'

export interface ScreenLabel {
  ref: RefObject<HTMLDivElement | null>
  position: [number, number, number] | null // world position, or null to hide
}

const v = new THREE.Vector3()

/**
 * Keeps plain DOM labels (rendered outside the <Canvas>, in the same container) pinned to 3D
 * points by projecting them every frame. Used instead of drei <Html>, whose per-label React roots
 * get torn down under React 19 StrictMode.
 */
export function ScreenLabels({ labels }: { labels: ScreenLabel[] }) {
  useFrame(({ camera, size }) => {
    for (const { ref, position } of labels) {
      const el = ref.current
      if (!el) continue
      if (!position) {
        el.style.display = 'none'
        continue
      }
      v.set(...position).project(camera)
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
