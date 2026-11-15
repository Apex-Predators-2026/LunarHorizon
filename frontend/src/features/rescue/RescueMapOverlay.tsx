// Mission Rescue in the 3D view: coral pins for the recommended alternatives (#1, #2...), a red
// marker where the changed plan fails (with the reason), small red dots for near-miss sites, and an
// emphasised pin for the selected alternative. All the "what to draw" logic is in rescueMapMarkers.
// Mounted inside the R3F canvas next to SitePins / BlockerLines (viz/Scene.tsx).
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'

import type { SiteInfo } from '../../types'
import type { SiteFrame } from '../../viz/globe/cubeSphere'
import { surfacePoint } from '../../viz/globe/overlays'
import { fetchRescueCatalog } from './api'
import { ALT_COLOR, overlayMarkers, summaryText as makeSummaryText, type RescueMarker } from './rescueMapMarkers'
import type { RescueResponse } from './types'
import { useRescueStore } from './useRescueStore'

// Pin stems scale with the camera distance so they stay a modest size on screen at any zoom.
const STEM_PER_DIST = 0.06
const STEM_MIN_M = 60
const STEM_MAX_M = 4500
const SELECTED_STEM_X = 1.6
const HEAD_PX = 10
const DOT_PX = 6
const SELECTED_PX = 18
// Label levels by camera distance to the rescue markers (metres).
const FAR_M = 300_000 // beyond this: one combined label only
const NEAR_MISS_LABEL_M = 60_000 // near-miss reasons only show when this close
const SAFE_TOP_PX = 130 // keep labels out of the page header band
const LABEL_SCALE = 0.0009 // sprite size per canvas pixel (sizeAttenuation off)
const ABOVE = -0.25 // sprite anchor: label sits just above its point
const BELOW = 1.25 // ... or just below it
const SUMMARY_BELOW = 3.4 // combined label: well below the pole, clear of the site tags there

function useDisposable<T extends { dispose(): void }>(make: () => T, deps: unknown[]): T {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const obj = useMemo(make, deps)
  useEffect(() => () => obj.dispose(), [obj])
  return obj
}

/** A small rounded label drawn once onto a canvas texture. */
function makeLabelTexture(text: string, color: string): { texture: THREE.CanvasTexture; w: number; h: number } {
  const ratio = 2
  const font = `600 ${12 * ratio}px system-ui, sans-serif`
  const probe = document.createElement('canvas').getContext('2d')!
  probe.font = font
  const w = Math.ceil(probe.measureText(text).width) + 16 * ratio
  const h = 22 * ratio
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const g = canvas.getContext('2d')!
  g.fillStyle = 'rgba(17, 20, 24, 0.82)'
  g.strokeStyle = color
  g.lineWidth = 2
  g.beginPath()
  g.roundRect(1, 1, w - 2, h - 2, 8 * ratio)
  g.fill()
  g.stroke()
  g.font = font
  g.textBaseline = 'middle'
  g.fillStyle = '#ffffff'
  g.fillText(text, 8 * ratio, h / 2 + 1)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return { texture, w: w / ratio, h: h / ratio }
}

interface LabelData {
  texture: THREE.CanvasTexture
  w: number
  h: number
}

function Label({ position, label, spriteRef }: {
  position: [number, number, number]
  label: LabelData
  spriteRef: (s: THREE.Sprite | null) => void
}) {
  const mat = useDisposable(
    () => new THREE.SpriteMaterial({ map: label.texture, depthTest: false, transparent: true, sizeAttenuation: false }),
    [label],
  )
  return (
    <sprite ref={spriteRef} position={position} center={new THREE.Vector2(0.5, ABOVE)}
      scale={[label.w * LABEL_SCALE, label.h * LABEL_SCALE, 1]} renderOrder={13}>
      <primitive object={mat} attach="material" />
    </sprite>
  )
}

/** Priority for label placement: selected, failing plan, alternatives by rank, then near-misses. */
const priorityOf = (m: RescueMarker) => (m.selected ? 0 : m.kind === 'failing' ? 1 : m.kind === 'alternative' ? 2 + (m.rank ?? 0) : 1000)

/**
 * Try the label above its point, then below it. It is accepted when it stays on screen, out of the
 * header band, and clear of the `n` rectangles already placed (it then joins them).
 */
function placeLabel(sp: THREE.Sprite, rects: Float32Array, n: number, x: number, y: number, w: number, h: number, W: number, H: number, belowLift = 0): boolean {
  // belowLift > 0: prefer a spot that far below the point (the combined label clears the pole's own tags)
  for (let k = 0; k < 2; k++) {
    const lift = (k === 0) === (belowLift === 0) ? ABOVE : belowLift || BELOW
    const top = y - (1 - lift) * h
    const bottom = y + lift * h
    const left = x - w / 2
    const right = x + w / 2
    if (top < SAFE_TOP_PX || bottom > H || left < 0 || right > W) continue
    let clear = true
    for (let i = 0; i < n; i++) {
      if (left < rects[i * 4 + 2] + 2 && right + 2 > rects[i * 4] && top < rects[i * 4 + 3] + 2 && bottom + 2 > rects[i * 4 + 1]) {
        clear = false
        break
      }
    }
    if (!clear) continue
    rects[n * 4] = left
    rects[n * 4 + 1] = top
    rects[n * 4 + 2] = right
    rects[n * 4 + 3] = bottom
    sp.center.y = lift
    return true
  }
  return false
}

function Markers({ frame, sites, markers, result }: { frame: SiteFrame; sites: SiteInfo[]; markers: RescueMarker[]; result: RescueResponse }) {
  const invalidate = useThree((s) => s.invalidate)
  const [stem, setStem] = useState(STEM_MIN_M) // pin height (m), follows the camera distance
  const stemRef = useRef(STEM_MIN_M)
  const placed = useMemo(() => {
    const height = new Map(sites.map((s) => [s.id, s.ground_height_m]))
    return markers.map((m) => {
      const ground = height.get(m.siteId) ?? frame.groundHeightM
      const up = (m.selected ? stem * SELECTED_STEM_X : stem) * (m.stemScale ?? 1)
      return {
        m,
        base: surfacePoint(frame, m.lat, m.lon, ground, 0),
        top: surfacePoint(frame, m.lat, m.lon, ground, up),
      }
    })
  }, [frame, sites, markers, stem])

  const lines = useDisposable(() => {
    const pos: number[] = []
    const col: number[] = []
    const c = new THREE.Color()
    for (const p of placed) {
      pos.push(...p.base, ...p.top)
      c.set(p.m.color)
      col.push(c.r, c.g, c.b, c.r, c.g, c.b)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
    return g
  }, [placed])
  // Heads: coloured dots (small for near-misses); selected pins also get a larger white halo.
  const headsOf = (pick: (m: RescueMarker) => boolean) => {
    const g = new THREE.BufferGeometry()
    const sel = placed.filter((p) => pick(p.m))
    const c = new THREE.Color()
    g.setAttribute('position', new THREE.Float32BufferAttribute(sel.flatMap((p) => p.top), 3))
    g.setAttribute('color', new THREE.Float32BufferAttribute(sel.flatMap((p) => (c.set(p.m.color), [c.r, c.g, c.b])), 3))
    return g
  }
  const heads = useDisposable(() => headsOf((m) => m.kind !== 'near_miss'), [placed])
  const dots = useDisposable(() => headsOf((m) => m.kind === 'near_miss'), [placed])
  const halo = useDisposable(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(placed.filter((p) => p.m.selected).flatMap((p) => p.top), 3))
    return g
  }, [placed])
  const lineMat = useDisposable(() => new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false }), [])
  const haloMat = useDisposable(
    () => new THREE.PointsMaterial({ color: '#ffffff', size: SELECTED_PX, sizeAttenuation: false, depthTest: false }),
    [],
  )
  const headMat = useDisposable(
    () => new THREE.PointsMaterial({ vertexColors: true, size: HEAD_PX, sizeAttenuation: false, depthTest: false }),
    [],
  )
  const dotMat = useDisposable(
    () => new THREE.PointsMaterial({ vertexColors: true, size: DOT_PX, sizeAttenuation: false, depthTest: false }),
    [],
  )
  useEffect(() => invalidate())

  // Label textures: one per marker (text is fixed) plus the combined far-zoom label.
  const summaryText = makeSummaryText(result)
  const labels = useMemo(() => markers.map((m) => makeLabelTexture(m.label, m.color)), [markers])
  useEffect(() => () => labels.forEach((l) => l.texture.dispose()), [labels])
  const summaryLabel = useMemo(() => makeLabelTexture(summaryText, ALT_COLOR), [summaryText])
  useEffect(() => () => summaryLabel.texture.dispose(), [summaryLabel])

  // Placement order (priority) and scratch objects, built once per marker set.
  const order = useMemo(() => markers.map((_, i) => i).sort((a, b) => priorityOf(markers[a]) - priorityOf(markers[b])), [markers])
  const scratch = useMemo(
    () => ({ v: new THREE.Vector3(), n: new THREE.Vector3(), rects: new Float32Array(4 * (markers.length + 1)) }),
    [markers],
  )
  const bases = useMemo(() => placed.map((p) => new THREE.Vector3(...p.base)), [placed])
  const centre = useMemo(() => {
    const c = new THREE.Vector3()
    for (const b of bases) c.add(b)
    return bases.length ? c.divideScalar(bases.length) : c
  }, [bases])
  const moon = useMemo(() => new THREE.Vector3(...frame.toSite([0, 0, 0])), [frame])
  const sprites = useRef<(THREE.Sprite | null)[]>([])
  const summary = useRef<THREE.Sprite | null>(null)

  // Per frame (no re-render unless the pin height changes by >10%): labels by level (one combined
  // label when far, individual ones when near), hiding the far side of the Moon, the header band and
  // anything overlapping a higher-priority label.
  useFrame(({ camera, size }) => {
    let dmin = Infinity
    for (let i = 0; i < bases.length; i++) dmin = Math.min(dmin, camera.position.distanceTo(bases[i]))
    const want = Math.min(STEM_MAX_M, Math.max(STEM_MIN_M, dmin * STEM_PER_DIST))
    if (Math.abs(want / stemRef.current - 1) > 0.1) {
      stemRef.current = want
      setStem(want)
    }

    const { v, n, rects } = scratch
    const far = camera.position.distanceTo(centre) > FAR_M
    const fov = (camera as THREE.PerspectiveCamera).fov ?? 50
    const k = size.height / (2 * Math.tan((fov * Math.PI) / 360)) // screen px per unit sprite scale
    // Projects the sprite's anchor into `v`; false when on the far side of the Moon or off screen.
    const project = (sp: THREE.Sprite) => {
      n.copy(sp.position).sub(moon)
      v.copy(camera.position).sub(sp.position)
      if (n.dot(v) < 0) return false
      v.copy(sp.position).project(camera)
      return v.z < 1 && Math.abs(v.x) < 1 && Math.abs(v.y) < 1
    }
    const sm = summary.current
    if (sm) {
      sm.visible = false
      if (far && project(sm)) {
        sm.visible = placeLabel(
          sm, rects, 0, ((v.x + 1) / 2) * size.width, ((1 - v.y) / 2) * size.height,
          summaryLabel.w * LABEL_SCALE * k, summaryLabel.h * LABEL_SCALE * k, size.width, size.height, SUMMARY_BELOW,
        )
      }
    }
    for (let i = 0; i < sprites.current.length; i++) {
      const sp = sprites.current[i]
      if (sp) sp.visible = false
    }
    if (far) return
    let placedN = 0
    for (let j = 0; j < order.length; j++) {
      const i = order[j]
      const sp = sprites.current[i]
      if (!sp || !labels[i]) continue
      if (markers[i].kind === 'near_miss' && camera.position.distanceTo(sp.position) > NEAR_MISS_LABEL_M) continue
      if (!project(sp)) continue
      const lb = labels[i]
      if (placeLabel(sp, rects, placedN, ((v.x + 1) / 2) * size.width, ((1 - v.y) / 2) * size.height,
        lb.w * LABEL_SCALE * k, lb.h * LABEL_SCALE * k, size.width, size.height)) {
        sp.visible = true
        placedN++
      }
    }
  })

  return (
    <group renderOrder={12}>
      <lineSegments geometry={lines} material={lineMat} renderOrder={12} />
      <points geometry={halo} material={haloMat} renderOrder={12} />
      <points geometry={heads} material={headMat} renderOrder={13} />
      <points geometry={dots} material={dotMat} renderOrder={13} />
      <Label position={[centre.x, centre.y, centre.z]} label={summaryLabel}
        spriteRef={(sp) => { summary.current = sp }} />
      {placed.map((p, i) => (
        <Label key={p.m.id} position={p.top} label={labels[i]}
          spriteRef={(sp) => { sprites.current[i] = sp }} />
      ))}
    </group>
  )
}

/** Draws the rescue result on the 3D map. Shows nothing without a result or with "Show on map" off. */
export function RescueMapOverlay({ frame, sites }: { frame: SiteFrame; sites: SiteInfo[] }) {
  const result = useRescueStore((s) => s.rescue)
  const show = useRescueStore((s) => s.showOnMap)
  const selected = useRescueStore((s) => s.selected)
  const catalog = useRescueStore((s) => s.catalog)
  const wanted = show && !!result

  // The catalog gives each site's coordinates; load it once if the panel has not.
  useEffect(() => {
    if (!wanted || catalog) return
    const ctl = new AbortController()
    fetchRescueCatalog(ctl.signal).then((c) => useRescueStore.getState().setCatalog(c), () => undefined)
    return () => ctl.abort()
  }, [wanted, catalog])

  // Scene passes a fresh array while loading; only the heights matter, so key on the length.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableSites = useMemo(() => sites, [sites.length])
  const markers = useMemo(() => overlayMarkers({ rescue: result, showOnMap: show, selected, catalog }), [show, result, catalog, selected])
  if (!result || markers.length === 0) return null
  return <Markers frame={frame} sites={stableSites} markers={markers} result={result} />
}
