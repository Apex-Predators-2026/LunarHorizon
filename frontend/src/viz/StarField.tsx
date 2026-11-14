import { useThree } from '@react-three/fiber'
import { useEffect, useMemo, useState } from 'react'
import * as THREE from 'three'
import type { SiteFrame } from './globe/cubeSphere'
import { daysSinceJ2000, siteFromInertial } from './sky/celestial'
import { loadStars, starColour, starLook, type Star } from './sky/stars'

const VERTEX = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute float size;
  attribute vec3 tint;
  attribute float alpha;
  uniform float pixelRatio;
  varying vec3 vTint;
  varying float vAlpha;
  void main() {
    vTint = tint;
    vAlpha = alpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = size * pixelRatio;
    #include <logdepthbuf_vertex>
  }
`
const FRAGMENT = /* glsl */ `
  #include <logdepthbuf_pars_fragment>
  varying vec3 vTint;
  varying float vAlpha;
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(p, p);
    if (r2 > 1.0) discard;
    // A round point with a flat core and a soft edge: tiny points (faint stars, 2-3 px) keep their
    // brightness, the bigger ones still look round and slightly brighter in the middle.
    float a = vAlpha * (1.0 - smoothstep(0.55, 1.0, sqrt(r2))) * (0.75 + 0.25 * exp(-r2 * 4.0));
    gl_FragColor = vec4(vTint * a, 1.0); // additive blending scales by alpha: already applied here
    #include <logdepthbuf_fragment>
  }
`

/**
 * The real night sky (Hipparcos stars to magnitude 6.5, see sky/stars.ts) as the lander sees it at the
 * selected time: true positions, brightness and colours, turning slowly with the Moon. Render inside
 * <FollowCamera>; terrain in front hides the stars behind it. `count` = how many of the brightest.
 */
export function StarField({ frame, timeUtc, radius, count }: { frame: SiteFrame | null; timeUtc: string | null; radius: number; count: number }) {
  const [stars, setStars] = useState<Star[] | null>(null)
  const invalidate = useThree((s) => s.invalidate)
  const dpr = useThree((s) => s.viewport.dpr)
  useEffect(() => {
    let live = true
    void loadStars().then((s) => {
      if (!live) return
      setStars(s)
      invalidate()
    })
    return () => {
      live = false
    }
  }, [invalidate])

  const geometry = useMemo(() => {
    if (!stars) return null
    const n = Math.min(count, stars.length)
    const pos = new Float32Array(n * 3)
    const tint = new Float32Array(n * 3)
    const size = new Float32Array(n)
    const alpha = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const s = stars[i]
      pos.set(s.dir.map((v) => v * radius), i * 3)
      tint.set(starColour(s.bv), i * 3)
      const look = starLook(s.mag)
      size[i] = look.size
      alpha[i] = look.alpha
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('tint', new THREE.BufferAttribute(tint, 3))
    g.setAttribute('size', new THREE.BufferAttribute(size, 1))
    g.setAttribute('alpha', new THREE.BufferAttribute(alpha, 1))
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), radius) // all around the viewer
    return g
  }, [stars, count, radius])
  useEffect(() => () => geometry?.dispose(), [geometry])

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        uniforms: { pixelRatio: { value: dpr } }, // star sizes are in CSS px
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      }),
    [dpr],
  )
  useEffect(() => () => material.dispose(), [material])

  // The sky turns with the Moon: inertial (catalogue) -> site frame at the selected time.
  const rotation = useMemo(() => {
    if (!frame || !timeUtc) return null
    const m = siteFromInertial(daysSinceJ2000(Date.parse(timeUtc)), frame)
    const m4 = new THREE.Matrix4().set(m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0, 0, 0, 0, 1)
    return new THREE.Quaternion().setFromRotationMatrix(m4)
  }, [frame, timeUtc])

  if (!geometry || !rotation) return null
  return <points geometry={geometry} material={material} quaternion={rotation} frustumCulled={false} renderOrder={-2} />
}
