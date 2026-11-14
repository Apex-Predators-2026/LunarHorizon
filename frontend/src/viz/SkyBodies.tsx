import { useThree } from '@react-three/fiber'
import { useEffect, useMemo, useState } from 'react'
import * as THREE from 'three'
import type { TimelineStep } from '../types'
import type { SiteFrame } from './globe/cubeSphere'
import { skyPositions } from './geometry'
import { daysSinceJ2000, siteFromEarthFixed } from './sky/celestial'

const SUN_RADIUS_DEG = 0.2666 // apparent solar radius
const EARTH_RADIUS_DEG = 0.95 // Earth seen from the Moon (6371 km / 384,400 km)

function radiusAt(distance: number, angularRadiusDeg: number) {
  return distance * Math.tan((angularRadiusDeg * Math.PI) / 180)
}

const LOGDEPTH_VERTEX_HEAD = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
`

// The Sun's disc: limb darkening (the edge of the disc is dimmer, I = 1 - 0.6 (1 - mu)).
const SUN_VERTEX = /* glsl */ `
  ${LOGDEPTH_VERTEX_HEAD}
  varying float vMu;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vec3 n = normalize(mat3(modelMatrix) * normal);
    vMu = max(dot(n, normalize(cameraPosition - world.xyz)), 0.0);
    gl_Position = projectionMatrix * viewMatrix * world;
    #include <logdepthbuf_vertex>
  }
`
const SUN_FRAGMENT = /* glsl */ `
  #include <logdepthbuf_pars_fragment>
  varying float vMu;
  void main() {
    float limb = 1.0 - 0.6 * (1.0 - vMu);
    gl_FragColor = vec4(vec3(1.0, 0.97, 0.9) * (0.75 + 0.6 * limb), 1.0);
    #include <logdepthbuf_fragment>
  }
`

// Earth: the Blue Marble map lit by the Sun (its real phase from the Moon) with a thin blue atmosphere
// on the lit limb. The night side is nearly black.
const EARTH_VERTEX = /* glsl */ `
  ${LOGDEPTH_VERTEX_HEAD}
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vNormal = normalize(mat3(modelMatrix) * normal);
    vView = normalize(cameraPosition - world.xyz);
    gl_Position = projectionMatrix * viewMatrix * world;
    #include <logdepthbuf_vertex>
  }
`
const EARTH_FRAGMENT = /* glsl */ `
  #include <logdepthbuf_pars_fragment>
  uniform sampler2D map;
  uniform vec3 sunDir;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vec3 n = normalize(vNormal);
    float cosSun = dot(n, sunDir);
    float day = smoothstep(-0.06, 0.18, cosSun);
    vec3 surface = texture2D(map, vUv).rgb;
    // From the Moon, Earth is a brilliant blue-white (clouds); the cloud-free map is much darker: brighten
    // it and add an even haze of cloud on the day side.
    vec3 lit = mix(surface * 1.8, vec3(0.8, 0.86, 0.96), 0.3);
    vec3 color = lit * day + surface * 0.03;
    float rim = pow(1.0 - max(dot(n, normalize(vView)), 0.0), 2.5);
    color += vec3(0.35, 0.6, 1.0) * rim * smoothstep(-0.25, 0.25, cosSun) * 0.9; // atmosphere, lit side
    gl_FragColor = vec4(color, 1.0);
    #include <logdepthbuf_fragment>
  }
`

/** A soft round glare (white in the middle, fading out), drawn as a sprite. */
function glareTexture() {
  const size = 128
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')!
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  grad.addColorStop(0, 'rgba(255,250,235,1)')
  grad.addColorStop(0.08, 'rgba(255,244,214,0.75)')
  grad.addColorStop(0.25, 'rgba(255,226,170,0.22)')
  grad.addColorStop(0.55, 'rgba(255,210,150,0.06)')
  grad.addColorStop(1, 'rgba(255,200,140,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, size, size)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

// Earth's map is equirectangular (lon -180 at the left); a three.js sphere puts lon 0 on +x, lon 90E
// on -z and north on +y. This turns that sphere's axes into Earth-fixed ones (x lon 0, y lon 90E, z north).
const SPHERE_TO_EARTH = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1)

/**
 * Sun and Earth at their true angular size and position (JPL Horizons, via the engine), just beyond
 * the horizon curtain. The Sun: a limb-darkened disc and a soft glare (scaled by how much of it clears
 * the terrain). Earth: the NASA Blue Marble, lit by the Sun so its phase is right, turned to show the
 * side facing the Moon at that time (sky/celestial.ts). Render inside <FollowCamera>.
 */
export function SkyBodies({ status, distance, frame }: { status: TimelineStep; distance: number; frame: SiteFrame | null }) {
  const pos = skyPositions(status, distance, 0)
  const sunR = radiusAt(distance, SUN_RADIUS_DEG)
  const earthR = radiusAt(distance, EARTH_RADIUS_DEG)
  const visible = status.sun.visible_fraction ?? (status.sun.visible ? 1 : 0)

  // Earth's map, loaded once (Earth isn't drawn until it's there).
  const invalidate = useThree((st) => st.invalidate)
  const [earthMap, setEarthMap] = useState<THREE.Texture | null>(null)
  useEffect(() => {
    let live = true
    let tex: THREE.Texture | null = null
    new THREE.TextureLoader().loadAsync(`${import.meta.env.BASE_URL}sky/earth.jpg`).then(
      (t) => {
        tex = t
        if (!live) return t.dispose()
        t.colorSpace = THREE.SRGBColorSpace
        t.anisotropy = 4
        setEarthMap(t)
        invalidate()
      },
      (e: unknown) => console.warn('Earth map unavailable.', e),
    )
    return () => {
      live = false
      tex?.dispose()
    }
  }, [invalidate])
  const glare = useMemo(() => glareTexture(), [])
  useEffect(() => () => glare.dispose(), [glare])

  const sunMaterial = useMemo(
    () => new THREE.ShaderMaterial({ vertexShader: SUN_VERTEX, fragmentShader: SUN_FRAGMENT, toneMapped: false }),
    [],
  )
  const earthMaterial = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: EARTH_VERTEX,
        fragmentShader: EARTH_FRAGMENT,
        uniforms: { map: { value: earthMap }, sunDir: { value: new THREE.Vector3(0, 1, 0) } },
        toneMapped: false,
      }),
    [earthMap],
  )
  useEffect(() => () => sunMaterial.dispose(), [sunMaterial])
  useEffect(() => () => earthMaterial.dispose(), [earthMaterial])

  // Light Earth from where the Sun is (both are so far away that the direction is the same).
  const [sx, sy, sz] = pos.sun
  useEffect(() => {
    earthMaterial.uniforms.sunDir.value.set(sx, sy, sz).normalize()
  }, [earthMaterial, sx, sy, sz])

  // Turn Earth's globe as it is at that time (which longitudes face the Moon, its axis).
  const earthTurn = useMemo(() => {
    if (!frame) return new THREE.Quaternion()
    const m = siteFromEarthFixed(daysSinceJ2000(Date.parse(status.time_utc)), frame)
    const toSite = new THREE.Matrix4().set(m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0, 0, 0, 0, 1)
    return new THREE.Quaternion().setFromRotationMatrix(toSite.multiply(SPHERE_TO_EARTH))
  }, [frame, status.time_utc])

  return (
    <>
      <mesh position={pos.sun} material={sunMaterial} renderOrder={-1}>
        <sphereGeometry args={[sunR, 32, 16]} />
      </mesh>
      {visible > 0 && (
        <>
          <sprite position={pos.sun} scale={[sunR * 16, sunR * 16, 1]} renderOrder={1}>
            <spriteMaterial map={glare} blending={THREE.AdditiveBlending} depthWrite={false} transparent opacity={0.9 * visible} toneMapped={false} />
          </sprite>
          <sprite position={pos.sun} scale={[sunR * 60, sunR * 60, 1]} renderOrder={1}>
            <spriteMaterial map={glare} blending={THREE.AdditiveBlending} depthWrite={false} transparent opacity={0.22 * visible} toneMapped={false} />
          </sprite>
        </>
      )}
      {earthMap && (
        <mesh position={pos.earth} quaternion={earthTurn} material={earthMaterial} renderOrder={-1}>
          <sphereGeometry args={[earthR, 64, 32]} />
        </mesh>
      )}
    </>
  )
}
