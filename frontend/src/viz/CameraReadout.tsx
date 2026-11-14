import { useFrame, useThree } from '@react-three/fiber'
import type { PerspectiveCamera } from 'three'
import type { RefObject } from 'react'
import { MOON_RADIUS_M, vecToLatLon, type SiteFrame } from './globe/cubeSphere'
import { fmtDistance } from './globe/overlays'

const fmtLatLon = (lat: number, lon: number) => {
  const e = ((((lon + 180) % 360) + 360) % 360) - 180 // -180..180, like Google Earth
  return `${Math.abs(lat).toFixed(4)}° ${lat < 0 ? 'S' : 'N'}  ${Math.abs(e).toFixed(4)}° ${e < 0 ? 'W' : 'E'}`
}

/**
 * Writes the camera's position into a DOM element (no React re-render): the latitude / longitude of
 * the point on the Moon directly beneath the camera, and the camera's height above the mean surface.
 * Runs on rendered frames only, so it costs nothing while the view is still.
 */
const MAX_BAR_PX = 110
const nice = (m: number) => {
  const p = 10 ** Math.floor(Math.log10(m))
  const f = m / p
  return p * (f >= 5 ? 5 : f >= 2 ? 2 : 1)
}

export function CameraReadout({
  frame,
  target,
  scaleBar,
  scaleLabel,
}: {
  frame: SiteFrame | null
  target: RefObject<HTMLElement | null>
  scaleBar: RefObject<HTMLElement | null> // its width is set to the on-screen length of the scale
  scaleLabel: RefObject<HTMLElement | null> // e.g. "5 km"
}) {
  const controls = useThree((s) => s.controls) as { target?: { distanceTo: (v: unknown) => number } } | null
  useFrame(({ camera, size }) => {
    const el = target.current
    if (!el || !frame) return
    const m = frame.toMoon([camera.position.x, camera.position.y, camera.position.z])
    const r = Math.hypot(m[0], m[1], m[2])
    const [lat, lon] = vecToLatLon(m)
    const text = `${fmtLatLon(lat, lon)}   Camera alt ${fmtDistance(Math.max(0, r - MOON_RADIUS_M))}`
    if (el.textContent !== text) el.textContent = text

    // Scale: how many metres one screen pixel covers at the distance of what you are looking at.
    const bar = scaleBar.current
    const label = scaleLabel.current
    if (!bar || !label) return
    let depth = controls?.target ? controls.target.distanceTo(camera.position) : r - MOON_RADIUS_M
    if (!(depth < 100_000)) {
      // Far out: use the distance to the Moon's surface along the line of sight (the target is the centre).
      const c = frame.toSite([0, 0, 0]) // Moon centre in scene coordinates (the scene is in the site frame)
      const d = camera.getWorldDirection(camera.position.clone())
      const oc = [camera.position.x - c[0], camera.position.y - c[1], camera.position.z - c[2]]
      const b = oc[0] * d.x + oc[1] * d.y + oc[2] * d.z
      const disc = b * b - (oc[0] ** 2 + oc[1] ** 2 + oc[2] ** 2 - MOON_RADIUS_M ** 2)
      depth = disc >= 0 ? Math.max(-b - Math.sqrt(disc), 1) : Math.max(r - MOON_RADIUS_M, 1)
    }
    const fov = ((camera as PerspectiveCamera).fov * Math.PI) / 180
    const metresPerPx = (2 * Math.max(depth, 1) * Math.tan(fov / 2)) / size.height
    const len = nice(metresPerPx * MAX_BAR_PX)
    bar.style.width = `${(len / metresPerPx).toFixed(1)}px`
    const t = fmtDistance(len)
    if (label.textContent !== t) label.textContent = t
  })
  return null
}
