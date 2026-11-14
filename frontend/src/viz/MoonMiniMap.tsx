import { useEffect, useMemo, useRef, useState } from 'react'
import type { SiteInfo, TimelineStep } from '../types'
import { flyTo } from './cameraTilt'
import { latLonToVec, MOON_RADIUS_M, type SiteFrame, type Vec3 } from './globe/cubeSphere'
import { packFaceImages } from './globe/imageryPack'
import { faceSampler, mapViewFor, project, renderMap, unproject, useCameraView, type LatLon, type MapView } from './globe/miniMap'
import { fmtDistance, siteColor } from './globe/overlays'
import { azElToVector } from './geometry'

const SIZE = 220 // CSS px, like the sky plot (the card keeps its size when switching tabs)
const C = SIZE / 2
const REDRAW_MS = 80 // the imagery is redrawn at most this often while the view moves
const SITE_HIT_PX = 7

const fmtLatLon = ([lat, lon]: LatLon) => {
  const e = ((((lon + 180) % 360) + 360) % 360) - 180
  return `${Math.abs(lat).toFixed(1)}°${lat < 0 ? 'S' : 'N'} ${Math.abs(e).toFixed(1)}°${e < 0 ? 'W' : 'E'}`
}

/**
 * Whole-Moon minimap (Google Earth's overview map, for the Moon): the LRO photo mosaic as a globe,
 * north up, centred on what the 3D view is looking at, zoomed to a few times its footprint (outlined),
 * lit by the Sun at the selected time. Dots = sites (colours as in 3D, the selected one ringed).
 * Click to spin the Moon there; click a site to go to it.
 */
export function MoonMiniMap({
  sites,
  siteId,
  frame,
  current,
}: {
  sites: SiteInfo[] | null
  siteId: string | null
  frame: SiteFrame | null
  current: TimelineStep | null
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [faces, setFaces] = useState<{ faces: Uint8ClampedArray[]; size: number } | null>(null)
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null) // SVG coordinates
  const view = useCameraView((s) => s.view)

  useEffect(() => {
    let live = true
    void packFaceImages().then((f) => live && setFaces(f))
    return () => {
      live = false
    }
  }, [])

  const selected = sites?.find((s) => s.id === siteId) ?? null
  const map: MapView = useMemo(
    () => (view ? mapViewFor(view) : { lat: selected?.lat ?? -90, lon: selected?.lon ?? 0, radius: Math.PI / 2 }),
    [view, selected?.lat, selected?.lon],
  )

  // Towards the Sun (Moon-fixed), from its direction in the sky at the site at the selected time.
  const sun = useMemo((): Vec3 | null => {
    if (!current || !frame) return null
    const [x, y, z] = azElToVector(current.sun.azimuth_deg, current.sun.elevation_deg) // x east, y up, z -north
    const { east: e, up: u, north: n } = frame
    return [x * e[0] + y * u[0] - z * n[0], x * e[1] + y * u[1] - z * n[1], x * e[2] + y * u[2] - z * n[2]]
  }, [current, frame])

  // Redraw the imagery (throttled: the latest view is always drawn within REDRAW_MS).
  const lastDraw = useRef(0)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !faces) return
    const draw = () => {
      lastDraw.current = performance.now()
      const px = canvas.width
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const img = ctx.createImageData(px, px)
      renderMap(img.data, px, map, faceSampler(faces.faces, faces.size), sun)
      ctx.putImageData(img, 0, 0)
    }
    const wait = REDRAW_MS - (performance.now() - lastDraw.current)
    if (wait <= 0) {
      draw()
      return
    }
    const t = setTimeout(draw, wait)
    return () => clearTimeout(t)
  }, [map, sun, faces])

  const toSvg = (ll: LatLon) => {
    const p = project(map, ll)
    return { x: C + p.x * C, y: C - p.y * C, shown: p.shown }
  }
  const siteDots = (sites ?? [])
    .map((s) => ({ s, ...toSvg([s.lat, s.lon]) }))
    .filter((d) => d.shown)
    .sort((a, b) => Number(a.s.id === siteId) - Number(b.s.id === siteId)) // the selected one on top
  const footprint = view?.footprint.map(toSvg).filter((p) => p.shown) ?? []
  const hoveredSite = hover
    ? siteDots.reduce<{ s: SiteInfo; d: number } | null>((best, d) => {
        const dist = Math.hypot(d.x - hover.x, d.y - hover.y)
        return dist <= SITE_HIT_PX && (!best || dist < best.d) ? { s: d.s, d: dist } : best
      }, null)?.s
    : null
  const hoverLatLon = hover ? unproject(map, (hover.x - C) / C, (C - hover.y) / C) : null

  const goTo = (ll: LatLon) => {
    if (!frame) return
    const v = latLonToVec(ll[0], ll[1])
    flyTo(frame.toSite([v[0] * MOON_RADIUS_M, v[1] * MOON_RADIUS_M, v[2] * MOON_RADIUS_M]))
  }
  const pointer = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    return { x: ((e.clientX - r.left) / r.width) * SIZE, y: ((e.clientY - r.top) / r.height) * SIZE }
  }
  const hemisphere = map.radius >= Math.PI / 2 - 1e-6
  const dpr = typeof window === 'undefined' ? 1 : Math.min(1.5, window.devicePixelRatio || 1)

  return (
    <figure className="relative m-0 flex w-full flex-col items-center rounded-[20px] px-3 pb-2 pt-1">
      <div className="relative" style={{ width: SIZE, height: SIZE }}>
        <canvas
          ref={canvasRef}
          width={Math.round(SIZE * dpr)}
          height={Math.round(SIZE * dpr)}
          className="absolute inset-0 rounded-[14px] bg-[#05080f]"
          style={{ width: SIZE, height: SIZE }}
          aria-hidden
        />
        <svg
          width={SIZE}
          height={SIZE}
          role="img"
          aria-label={`Minimap of the Moon, centred on ${view ? fmtLatLon(view.centre) : 'the site'}. Click to fly there.`}
          data-tip={hoveredSite ? `${hoveredSite.name}: click to go there` : 'Click anywhere on the Moon to fly there'}
          className="absolute inset-0 cursor-crosshair"
          onPointerMove={(e) => setHover(pointer(e))}
          onPointerLeave={() => setHover(null)}
          onClick={(e) => {
            const p = pointer(e)
            const site = siteDots.find((d) => Math.hypot(d.x - p.x, d.y - p.y) <= SITE_HIT_PX)?.s
            if (site) return goTo([site.lat, site.lon])
            const ll = unproject(map, (p.x - C) / C, (C - p.y) / C)
            if (ll) goTo(ll)
          }}
        >
          {hemisphere && <circle cx={C} cy={C} r={C - 0.5} fill="none" stroke="#8b93a5" strokeOpacity={0.5} />}
          {footprint.length >= 3 && (
            <polygon
              points={footprint.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}
              fill="#ff634a"
              fillOpacity={0.12}
              stroke="#ff634a"
              strokeWidth={1.5}
              strokeLinejoin="round"
            />
          )}
          {/* the middle of the 3D view */}
          <path d={`M${C - 5},${C} h10 M${C},${C - 5} v10`} stroke="#ffffff" strokeWidth={1.2} strokeOpacity={0.85} />
          {siteDots.map(({ s, x, y }) =>
            s.id === siteId ? (
              <g key={s.id}>
                <circle cx={x} cy={y} r={5.5} fill="none" stroke="#ff634a" strokeWidth={2} />
                <circle cx={x} cy={y} r={2} fill="#ffffff" />
              </g>
            ) : (
              <circle key={s.id} cx={x} cy={y} r={2.6} fill={siteColor(s)} stroke="#05080f" strokeWidth={0.8} />
            ),
          )}
          <text x={8} y={16} fontSize={10} fill="#e2e8f0" stroke="#05080f" strokeWidth={2.5} paintOrder="stroke">
            N ↑
          </text>
          <text x={SIZE - 8} y={SIZE - 8} fontSize={10} textAnchor="end" fill="#e2e8f0" stroke="#05080f" strokeWidth={2.5} paintOrder="stroke">
            {hemisphere ? 'whole hemisphere' : `${fmtDistance(2 * map.radius * MOON_RADIUS_M)} across`}
          </text>
        </svg>
        {!faces && <div className="absolute inset-0 flex items-center justify-center text-[11px] text-slate-400">Loading map…</div>}
      </div>
      <figcaption className="mt-1 h-4 w-full truncate text-center text-[11px] tabular-nums text-white/90">
        {hoveredSite ? hoveredSite.name : hoverLatLon ? `${fmtLatLon(hoverLatLon)} · click to fly here` : view ? `View: ${fmtLatLon(view.centre)}` : ' '}
      </figcaption>
    </figure>
  )
}
