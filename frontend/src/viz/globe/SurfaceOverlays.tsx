// Things drawn on the Moon's surface in the 3D view: site pins, permanently shadowed regions,
// surface-ice detections, and "failure lines" from the lander to the terrain that blocks the
// Sun or Earth. All positions come from backend data (site list, /api/psr, horizon mask).
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import type { Horizon, PsrData, SiteInfo, TimelineStep } from '../../types'
import { SiteFrame } from './cubeSphere'
import { blockerLine, horizonAt, KIND_COLOR, surfacePoint, type Blocker } from './overlays'

function useDisposable<T extends THREE.BufferGeometry | THREE.Material>(make: () => T, deps: unknown[]): T {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const obj = useMemo(make, deps)
  useEffect(() => () => obj.dispose(), [obj])
  return obj
}

/** Thin vertical pins at every site except the selected one (which has the lander). */
export function SitePins({ frame, sites, selectedId }: { frame: SiteFrame; sites: SiteInfo[]; selectedId: string | null }) {
  const geom = useDisposable(() => {
    const pos: number[] = []
    const col: number[] = []
    const c = new THREE.Color()
    for (const s of sites) {
      if (s.id === selectedId) continue
      const base = surfacePoint(frame, s.lat, s.lon, s.ground_height_m, 0)
      const top = surfacePoint(frame, s.lat, s.lon, s.ground_height_m, 3000)
      pos.push(...base, ...top)
      c.set(KIND_COLOR[s.kind ?? 'custom'] ?? KIND_COLOR.custom)
      col.push(c.r, c.g, c.b, c.r, c.g, c.b)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
    return g
  }, [frame, sites, selectedId])
  const mat = useDisposable(() => new THREE.LineBasicMaterial({ vertexColors: true }), [])
  return <lineSegments geometry={geom} material={mat} />
}

/** PSR outlines (circles of the same area: approximate) and surface-ice detections. */
export function PsrLayer({ frame, data }: { frame: SiteFrame; data: PsrData }) {
  const outlines = useDisposable(() => {
    const pos: number[] = []
    for (const p of data.psrs) {
      const pts = p.outline.filter((o) => o[2] !== null)
      for (let k = 0; k < pts.length; k++) {
        const a = pts[k]
        const b = pts[(k + 1) % pts.length]
        pos.push(...surfacePoint(frame, a[0], a[1], a[2]!, 40), ...surfacePoint(frame, b[0], b[1], b[2]!, 40))
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    return g
  }, [frame, data])
  const ice = useDisposable(() => {
    const pos: number[] = []
    for (const [lat, lon, h] of data.ice) if (h !== null) pos.push(...surfacePoint(frame, lat, lon, h, 30))
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    return g
  }, [frame, data])
  const lineMat = useDisposable(() => new THREE.LineBasicMaterial({ color: '#7dd3fc', transparent: true, opacity: 0.8 }), [])
  const iceMat = useDisposable(
    () => new THREE.PointsMaterial({ color: '#e0f2fe', size: 3, sizeAttenuation: false, transparent: true, opacity: 0.9 }),
    [],
  )
  return (
    <group>
      <lineSegments geometry={outlines} material={lineMat} />
      <points geometry={ice} material={iceMat} />
    </group>
  )
}

/**
 * Failure lines: a bold line from the lander to the terrain blocking the Sun / Earth right now, and
 * a faint fan to every terrain point that blocks them at some hour of the loaded time window.
 */
export function BlockerLines({
  steps,
  current,
  horizon,
  eyeHeightM,
}: {
  steps: TimelineStep[]
  current: Blocker[]
  horizon: Horizon
  eyeHeightM: number
}) {
  const fan = useDisposable(() => {
    const pos: number[] = []
    const col: number[] = []
    const seen = new Set<string>()
    const colours = { sun: new THREE.Color('#ef4444'), earth: new THREE.Color('#60a5fa') }
    for (const s of steps) {
      for (const body of ['sun', 'earth'] as const) {
        const b = s[body]
        const key = `${body}${Math.round(b.azimuth_deg * 2)}`
        if (seen.has(key)) continue
        const h = b.horizon_deg ?? horizonAt(horizon.azimuth_deg, horizon.elevation_deg, b.azimuth_deg)
        const d = horizonAt(horizon.azimuth_deg, horizon.distance_m, b.azimuth_deg)
        const line = blockerLine(body, b.azimuth_deg, b.elevation_deg, h, d, eyeHeightM)
        if (!line) continue
        seen.add(key)
        pos.push(...line.from, ...line.to)
        const c = colours[body]
        col.push(c.r, c.g, c.b, c.r, c.g, c.b)
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
    return g
  }, [steps, horizon, eyeHeightM])
  const now = useDisposable(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(current.flatMap((b) => [...b.from, ...b.to]), 3))
    const col = current.flatMap((b) => (b.body === 'sun' ? [1, 0.27, 0.27, 1, 0.27, 0.27] : [0.38, 0.65, 0.98, 0.38, 0.65, 0.98]))
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
    return g
  }, [current])
  const fanMat = useDisposable(
    () => new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.25, depthTest: false }),
    [],
  )
  const nowMat = useDisposable(() => new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false }), [])
  return (
    <group renderOrder={10}>
      <lineSegments geometry={fan} material={fanMat} renderOrder={10} />
      <lineSegments geometry={now} material={nowMat} renderOrder={11} />
    </group>
  )
}
