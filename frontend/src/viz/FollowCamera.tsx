import { useFrame } from '@react-three/fiber'
import { useRef, type ReactNode } from 'react'
import type { Group } from 'three'

/**
 * Keeps its children centred on the camera (position only, like a skybox). Used for things that
 * are effectively at infinity: the distant-horizon curtain and the Sun/Earth discs. Anchoring them
 * to the lander instead makes them look like a giant floating bowl once you zoom out.
 *
 * Runs after GlobeControls' zoom easing (priority -1), so it never lags.
 */
export function FollowCamera({ children }: { children: ReactNode }) {
  const ref = useRef<Group>(null)
  useFrame(({ camera }) => {
    ref.current?.position.copy(camera.position)
  })
  return <group ref={ref}>{children}</group>
}
