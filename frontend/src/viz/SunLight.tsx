import { useFrame, useThree } from '@react-three/fiber'
import { useLayoutEffect, useRef } from 'react'
import type { DirectionalLight } from 'three'
import type { TimelineStep } from '../types'
import { azElToVector } from './geometry'

const MAX_INTENSITY = 3
// Camera distance from the site over which the light blends from "as seen at the lander" to
// "the real Sun lighting the whole Moon".
const NEAR_M = 20_000
const FAR_M = 150_000

/**
 * Sunlight from the computed azimuth/elevation. The Sun is effectively at infinity, so the same
 * direction lights the whole globe (and gives the right day/night line).
 *
 * Near the lander the intensity follows the engine's visible fraction of the solar disk. That
 * already includes terrain up to ~300 km away, which the shadow map (a few km around the site)
 * can't capture, so the lander is dark exactly when the numbers say it is. Zoomed out, the light
 * blends to full sunlight, because the globe as a whole is lit regardless of the lander's horizon.
 */
export function SunLight({
  status,
  shadowHalfWidth,
  shadows = true,
  shadowMapSize = 4096,
}: {
  status: TimelineStep
  shadowHalfWidth: number
  shadows?: boolean // terrain shadows near the lander (off in the low graphics preset)
  shadowMapSize?: number
}) {
  const ref = useRef<DirectionalLight>(null)
  const { sun } = status
  const pos = azElToVector(sun.azimuth_deg, sun.elevation_deg, 20000)
  const atLander = sun.visible_fraction ?? 0 // unknown -> no direct light at the lander
  const get = useThree((s) => s.get)

  // The shadow map (4096^2, every tile near the lander) only changes when the Sun moves or the
  // terrain detail changes (TileTree flags that), not when the camera moves: don't redraw it per frame.
  useLayoutEffect(() => {
    const { gl } = get()
    gl.shadowMap.autoUpdate = false
    gl.shadowMap.needsUpdate = true
    return () => {
      gl.shadowMap.autoUpdate = true
    }
  }, [get, sun.azimuth_deg, sun.elevation_deg, shadowHalfWidth])

  useFrame(({ camera }) => {
    if (!ref.current) return
    const d = camera.position.length()
    const t = Math.min(1, Math.max(0, (d - NEAR_M) / (FAR_M - NEAR_M)))
    const s = t * t * (3 - 2 * t) // smoothstep
    ref.current.intensity = MAX_INTENSITY * (atLander + (1 - atLander) * s)
  })

  return (
    <directionalLight
      ref={ref}
      position={pos}
      intensity={MAX_INTENSITY * atLander}
      castShadow={shadows}
      shadow-mapSize={[shadowMapSize, shadowMapSize]}
      shadow-camera-left={-shadowHalfWidth}
      shadow-camera-right={shadowHalfWidth}
      shadow-camera-top={shadowHalfWidth}
      shadow-camera-bottom={-shadowHalfWidth}
      shadow-camera-near={1}
      shadow-camera-far={45000}
      shadow-bias={-0.0004}
      shadow-normalBias={8}
    />
  )
}
