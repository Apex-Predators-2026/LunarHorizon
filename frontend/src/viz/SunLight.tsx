import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useRef } from 'react'
import * as THREE from 'three'
import { CSM } from 'three/examples/jsm/csm/CSM.js'
import type { TimelineStep } from '../types'
import { azElToVector } from './geometry'

const MAX_INTENSITY = 3
// Camera distance from the site over which the light blends from "as seen at the lander" to
// "the real Sun lighting the whole Moon".
const NEAR_M = 20_000
const FAR_M = 150_000

/**
 * Near the lander the intensity follows the engine's visible fraction of the solar disk. That
 * already includes terrain up to ~300 km away, which the shadow maps can't fully capture, so the
 * lander is dark exactly when the numbers say it is. Zoomed out, the light blends to full
 * sunlight, because the globe as a whole is lit regardless of the lander's horizon.
 */
function sunIntensity(visibleFraction: number, cameraDistance: number) {
  const t = Math.min(1, Math.max(0, (cameraDistance - NEAR_M) / (FAR_M - NEAR_M)))
  const s = t * t * (3 - 2 * t) // smoothstep
  return MAX_INTENSITY * (visibleFraction + (1 - visibleFraction) * s)
}

/**
 * Sunlight from the computed azimuth/elevation. The Sun is effectively at infinity, so the same
 * direction lights the whole globe (and gives the right day/night line).
 *
 * Shadows: by default one shadow map ~12 km around the lander, redrawn only when the Sun or the
 * terrain detail changes. With `far` on, cascaded shadow maps cover the whole view instead.
 */
export function SunLight({
  status,
  shadowHalfWidth,
  shadows = true,
  shadowMapSize = 4096,
  far = false,
}: {
  status: TimelineStep
  shadowHalfWidth: number
  shadows?: boolean // terrain shadows near the lander (off in the low graphics preset)
  shadowMapSize?: number
  far?: boolean // cascaded shadows across the whole view (needs `shadows`)
}) {
  return far && shadows ? (
    <CascadedSunLight status={status} />
  ) : (
    <SingleSunLight status={status} shadowHalfWidth={shadowHalfWidth} shadows={shadows} shadowMapSize={shadowMapSize} />
  )
}

function SingleSunLight({
  status,
  shadowHalfWidth,
  shadows,
  shadowMapSize,
}: {
  status: TimelineStep
  shadowHalfWidth: number
  shadows: boolean
  shadowMapSize: number
}) {
  const ref = useRef<THREE.DirectionalLight>(null)
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
    if (ref.current) ref.current.intensity = sunIntensity(atLander, camera.position.length())
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

const CASCADES = 4
const CASCADE_MAP_PX = 2048

const isLit = (m: THREE.Material) =>
  (m as THREE.MeshStandardMaterial).isMeshStandardMaterial ||
  (m as THREE.MeshLambertMaterial).isMeshLambertMaterial ||
  (m as THREE.MeshPhongMaterial).isMeshPhongMaterial

/**
 * Cascaded shadow maps (three.js CSM): 4 shadow maps of 2048^2, the nearest covering the area
 * around the camera's target in detail and each further one 3-10x larger, out to the terrain on
 * the horizon. The ranges scale with how far the camera is from the lander, so a close-up gets
 * sharp shadows and the region view gets shadows across hundreds of km. They follow the camera,
 * so they are redrawn whenever it moves (on demand, not every frame).
 * Only terrain that is drawn can cast shadows (tiles off screen are not loaded).
 */
function CascadedSunLight({ status }: { status: TimelineStep }) {
  const get = useThree((s) => s.get)
  const invalidate = useThree((s) => s.invalidate)
  const { sun } = status
  const atLander = sun.visible_fraction ?? 0
  const live = useRef<Cascades | null>(null)

  useEffect(() => {
    const { scene, camera, gl } = get()
    const c: Cascades = { csm: null as unknown as CSM, patched: new Set(), firstSplit: 1000, near: 0, far: 0 }
    c.csm = new CSM({
      camera,
      parent: scene,
      cascades: CASCADES,
      shadowMapSize: CASCADE_MAP_PX,
      lightIntensity: 0, // set every frame
      mode: 'custom',
      // Geometric splits from firstSplit out to the far distance.
      customSplitsCallback: (n, _near, far, breaks) => {
        const d0 = Math.min(c.firstSplit, far / 8)
        const k = (far / d0) ** (1 / (n - 1))
        for (let i = 0; i < n - 1; i++) breaks.push((d0 * k ** i) / far)
        breaks.push(1)
      },
      maxFar: 50_000,
      lightMargin: 25_000,
      lightFar: 200_000,
    })
    live.current = c
    gl.shadowMap.autoUpdate = true // the cascades follow the camera
    invalidate()
    return () => {
      c.csm.dispose() // un-patches every material it set up
      for (const m of c.patched) m.needsUpdate = true
      c.csm.remove()
      for (const l of c.csm.lights) l.dispose()
      live.current = null
      invalidate()
    }
  }, [get, invalidate])

  useEffect(() => {
    const c = live.current
    if (!c) return
    const [x, y, z] = azElToVector(sun.azimuth_deg, sun.elevation_deg, 1)
    c.csm.lightDirection.set(-x, -y, -z).normalize() // the direction the light travels
    invalidate()
  }, [sun.azimuth_deg, sun.elevation_deg, invalidate])

  useFrame(({ camera, scene }) => {
    const c = live.current
    if (!c) return
    const { csm } = c
    // Every lit material in the scene (terrain, imagery tiles, the rover) needs the CSM shader.
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (!c.patched.has(m) && isLit(m)) {
          csm.setupMaterial(m)
          m.needsUpdate = true
          c.patched.add(m)
        }
      }
    })
    // Ranges from the camera's distance to the lander: detail near the target, out to the horizon.
    const d = camera.position.length()
    const near = Math.min(2_000_000, Math.max(150, d * 1.5))
    const far = Math.min(3_000_000, Math.max(20_000, d * 25))
    if (Math.abs(far - c.far) > 0.1 * c.far || Math.abs(near - c.near) > 0.1 * c.near) {
      c.near = near
      c.far = far
      c.firstSplit = near
      csm.maxFar = far
      csm.lightMargin = far * 0.5 // terrain this far towards the Sun can still cast shadows into view
      setShadowDepth(csm.lights, csm.lightMargin + 2 * far)
      csm.updateFrustums()
    }
    csm.update()
    updateCascadeLights(csm.lights, sunIntensity(atLander, d))
  })

  return null
}

/** Sun intensity on every cascade light, and shadow bias in proportion to each cascade's texel size
 * (from metres near the camera to kilometres far away). */
function updateCascadeLights(lights: THREE.DirectionalLight[], intensity: number) {
  for (const light of lights) {
    light.intensity = intensity
    light.shadow.normalBias = ((light.shadow.camera.right - light.shadow.camera.left) / CASCADE_MAP_PX) * 1.5
    light.shadow.bias = -0.00005
  }
}

/** How deep each cascade's shadow camera looks along the light (margin towards the Sun + range). */
function setShadowDepth(lights: THREE.DirectionalLight[], depth: number) {
  for (const light of lights) light.shadow.camera.far = depth
}

interface Cascades {
  csm: CSM
  patched: Set<THREE.Material> // materials set up for the CSM shader (un-patched on unmount)
  firstSplit: number // m, read by the split callback
  near: number
  far: number
}
