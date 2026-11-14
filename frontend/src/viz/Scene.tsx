import { Stars } from '@react-three/drei'
import { Canvas } from '@react-three/fiber'
import { createRef, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import * as THREE from 'three'
import { useAppStore } from '../store'
import type { SiteInfo } from '../types'
import { createCustomSite, fetchHorizon, fetchPsr, fetchSites, fetchStatus, fetchTimeline, useAsync } from './api'
import { CameraRig, type ViewMode } from './CameraRig'
import { FollowCamera } from './FollowCamera'
import { MOON_RADIUS_M, SiteFrame, vecToLatLon, vertexSpacingM } from './globe/cubeSphere'
import { GlobeControls } from './GlobeControls'
import {
  analyseTraverse,
  findNearbyWaypoint,
  isLanderWaypointPresent,
  reindexWaypoints,
  removeWaypointById,
  renameWaypointById,
  waypointLabel,
  type MeasureWaypoint,
  type ProfileSample,
} from './globe/measure'
import { currentBlockers, fmtDistance, KIND_COLOR, surfacePoint } from './globe/overlays'
import { BlockerLines, MeasureOverlay, PsrLayer, SitePins } from './globe/SurfaceOverlays'
import type { TileHeights } from './globe/terrainHeight'
import { TileTree, type TileStats } from './globe/TileTree'
import { ColorKey, MapTools, type Layers, type PinState } from './MapTools'
import type { MeasureDrawer } from './MeasureCard'
import { HorizonCurtain } from './HorizonCurtain'
import { BEACON_HEIGHT, BEACON_HIDE_WITHIN_M, Lander } from './Lander'
import { skyPositions } from './geometry'
import { ScreenLabels } from './ScreenLabels'
import { SkyBodies } from './SkyBodies'
import { SkyTrails } from './SkyTrails'
import { SunLight } from './SunLight'
import { TimeBar } from './TimeBar'
import { CameraReadout } from './CameraReadout'
import { ViewCentre } from './ViewCentre'
import { fmtDeg, fmtPct, HOUR_MS, nearestIndex, parseUtc, toIsoMinute, windowFor } from './timeline'
import { FloatingSidebar } from './FloatingSidebar'
import { GRAPHICS, useGraphicsQuality, useStoredFlag } from './graphics'
import { MiniMapPanel } from './MiniMapPanel'
import { MiniMapTracker } from './MiniMapTracker'
import { MissionPanel } from './MissionPlayback'
import { useMissionPlayback } from './useMissionPlayback'
import { SnackbarHost } from './Snackbar'
import { TerrainLoadingOverlay, TerrainProgressBar } from './TerrainProgress'
import { CoverageBadge } from './CoverageBadge'
import { TooltipHost } from './TooltipHost'
import { showSnackbar } from './snackbarStore'
import { PERF_ENABLED, PERF_RENDER_ALWAYS } from './perf'
import { PerfOverlay, PerfProbe } from './PerfProbe'
import { SiteSelect, TopInfo, useViewerSetup } from './ViewerHud'

const SHADOW_HALF_WIDTH_M = 6000 // shadow map covers ~12 km around the lander
const CURTAIN_RADIUS_M = 28000 // engine skyline (from 300 km of terrain), drawn this far out in eye views
const SKY_DISTANCE_M = 1e8 // Sun/Earth/stars well beyond the Moon, so the globe can hide them
const MAX_CAMERA_DISTANCE_M = 8_000_000

const labelClass =
  'pointer-events-none absolute left-0 top-0 hidden whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] text-slate-100'

/**
 * 3D view of the selected site at the selected time, with playback, a window strip chart and a
 * sky plot. Everything shown comes from the backend (terrain tiles, horizon mask, hourly timeline),
 * so the 3D view and the charts always show the same numbers.
 */
export function Scene({ sidebar, fab }: { sidebar?: ReactNode; fab?: ReactNode }) {
  const siteId = useAppStore((s) => s.siteId)
  const timeUtc = useAppStore((s) => s.timeUtc)
  const playing = useAppStore((s) => s.playing)
  const [view, setView] = useState<ViewMode>('overview')
  const [windowDays, setWindowDays] = useState(14)
  const [terrainStats, setTerrainStats] = useState<TileStats | null>(null)
  const [layers, setLayers] = useState<Layers>({ sites: true, psr: true, blockers: true, paths: true })
  const [pin, setPin] = useState<PinState>({ phase: 'idle' })
  const [measureArmed, setMeasureArmed] = useState(false)
  const [waypoints, setWaypoints] = useState<MeasureWaypoint[]>([])
  const [selectedWaypointId, setSelectedWaypointId] = useState<string | null>(null)
  const [hoveredWaypointId, setHoveredWaypointId] = useState<string | null>(null)
  const [measureDrawer, setMeasureDrawer] = useState<MeasureDrawer>('none')
  const [hoveredSample, setHoveredSample] = useState<ProfileSample | null>(null)
  const tileHeightsRef = useRef<TileHeights | null>(null)
  const [createdSites, setCreatedSites] = useState<SiteInfo[]>([]) // pins dropped this session
  const setSite = useAppStore((s) => s.setSite)

  const fetchedSites = useAsync('sites', (sig) => fetchSites(sig))
  const allSites = useMemo(() => {
    const known = fetchedSites.data ?? []
    const extra = createdSites.filter((c) => !known.some((k) => k.id === c.id))
    return fetchedSites.data || extra.length ? [...known, ...extra] : null
  }, [fetchedSites.data, createdSites])
  const sites = { ...fetchedSites, data: allSites }
  const psr = useAsync(layers.psr ? 'psr' : null, (sig) => fetchPsr(sig))
  const site = sites.data?.find((s) => s.id === siteId) ?? null
  const inRange = !!site && timeUtc >= site.data_start_utc && timeUtc <= site.data_stop_utc
  const horizon = useAsync(site ? site.id : null, (sig) => fetchHorizon(site!.id, sig))

  // Whole-Moon terrain is drawn in a frame centred on the selected site (x east, y up, z -north).
  const frame = useMemo(
    () => (site ? new SiteFrame(site.lat, site.lon, site.ground_height_m) : null),
    [site],
  )
  // The side panels cover the right of the view: shift the picture so the Moon/lander sits in the
  // middle of the free area to their left (half the panels' width, re-measured on resize).
  const sideRef = useRef<HTMLDivElement>(null)
  const [cameraReset, setCameraReset] = useState(0)
  const readoutRef = useRef<HTMLDivElement>(null)
  const scaleBarRef = useRef<HTMLDivElement>(null)
  const scaleLabelRef = useRef<HTMLDivElement>(null)
  const compassRingRef = useRef<SVGGElement>(null)
  const compassNorthRef = useRef<SVGTextElement>(null)
  const [viewShiftPx, setViewShiftPx] = useState(0)
  useEffect(() => {
    const side = sideRef.current
    const host = side?.parentElement
    if (!side || !host || typeof ResizeObserver === 'undefined') return
    const measure = () => {
      const w = host.getBoundingClientRect().width
      const covered = host.getBoundingClientRect().right - side.getBoundingClientRect().left
      // On narrow screens the panels cover most of the view anyway: don't shift there.
      setViewShiftPx(covered > 0 && covered < w / 2 ? Math.round(covered / 2) : 0)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(side)
    ro.observe(host)
    return () => ro.disconnect()
  }, [])

  // Graphics preset (High = full quality, the default; Low for Chromebooks and old laptops).
  const [graphicsQuality, setGraphicsQuality] = useGraphicsQuality()
  const gfx = GRAPHICS[graphicsQuality]
  // Cascaded shadows across the whole view (off by default; needs a preset with shadows).
  const [farShadows, setFarShadows] = useStoredFlag('lunar-navigator.farShadows', false)
  const terrainMaterial = useMemo(
    () =>
      gfx.material === 'lambert'
        ? new THREE.MeshLambertMaterial({ color: '#9a9a9a' })
        : new THREE.MeshStandardMaterial({ color: '#9a9a9a', roughness: 0.95 }),
    [gfx.material],
  )
  useEffect(() => () => terrainMaterial.dispose(), [terrainMaterial])
  // Highest nearby terrain (from the horizon mask), so the overview camera starts above crater rims.
  const maxTerrainHeight = useMemo(() => {
    const h = horizon.data
    if (!h) return null
    let best = 0
    h.elevation_deg.forEach((el, k) => {
      const d = h.distance_m[k]
      if (el !== null && d !== null && d <= 6000) best = Math.max(best, d * Math.tan((el * Math.PI) / 180))
    })
    return best
  }, [horizon.data])
  // Re-render the HUD only when the stats actually change.
  const onStats = useCallback((s: TileStats) => {
    setTerrainStats((prev) =>
      prev && prev.visible === s.visible && prev.loading === s.loading && prev.deepest === s.deepest && prev.retrying === s.retrying
        ? prev
        : s,
    )
  }, [])

  // Hourly data for the window containing the selected time. Playback reads from this, so it only
  // refetches when it crosses into the next window.
  const now = parseUtc(timeUtc)
  const win: [number, number] | null = site
    ? windowFor(now, parseUtc(site.data_start_utc), parseUtc(site.data_stop_utc), windowDays)
    : null
  const winKey = site && win && inRange ? `${site.id}|${win[0]}|${win[1]}` : null
  const haveBar = !!(site && win)
  useEffect(() => {
    const el = barRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setBarNow(el.offsetHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [haveBar])
  const timeline = useAsync(winKey, (sig) =>
    fetchTimeline(site!.id, toIsoMinute(win![0]), toIsoMinute(win![1] + HOUR_MS), 1, sig),
  )
  const stepTimes = useMemo(() => (timeline.data ?? []).map((s) => parseUtc(s.time_utc)), [timeline.data])
  const i = nearestIndex(stepTimes, now)
  const current = i >= 0 && Math.abs(stepTimes[i] - now) <= HOUR_MS ? timeline.data![i] : null

  // Next sunset/Earthset need the whole 2-year record, so ask the backend, but only while paused.
  const status = useAsync(inRange && !playing ? `${site!.id}@${timeUtc}` : null, (sig) =>
    fetchStatus(site!.id, timeUtc, sig),
  )
  const events = status.data && current && status.data.time_utc === current.time_utc ? status.data : null

  const eye = site?.observer_height_m ?? 2
  const error = sites.error ?? horizon.error ?? timeline.error ?? status.error
  const loading = sites.loading || horizon.loading || timeline.loading

  useViewerSetup(sites.data)
  // Plays the sidebar's plan (landing to end) in the 3D view, pausing where it fails.
  const mission = useMissionPlayback(sites.data)
  const barRef = useRef<HTMLDivElement>(null)
  const [barHidden, setBarHidden] = useState(false)
  const [barH, setBarH] = useState(0)
  const [barNow, setBarNow] = useState(0) // live height of the timeline panel, so the + button sits just above it

  const sunLabel = useRef<HTMLDivElement>(null)
  const earthLabel = useRef<HTMLDivElement>(null)
  const landerLabel = useRef<HTMLDivElement>(null)
  const sky = current ? skyPositions(current, SKY_DISTANCE_M, 0) : null // relative to the camera
  const s = current
  const windowLabel = win ? `${toIsoMinute(win[0]).slice(5, 10)} → ${toIsoMinute(win[1]).slice(5, 10)}` : ''
  const eyeView = view === 'sun' || view === 'earth'

  // Other sites: pins + clickable labels.
  const otherSites = useMemo(() => (sites.data ?? []).filter((x) => x.id !== siteId), [sites.data, siteId])
  const siteLabelRefs = useMemo(() => {
    const m = new Map<string, RefObject<HTMLButtonElement | null>>()
    for (const x of otherSites) m.set(x.id, createRef<HTMLButtonElement>())
    return m
  }, [otherSites])
  // Failure lines: what blocks the Sun / Earth right now.
  const blockers = useMemo(() => currentBlockers(current, horizon.data, eye), [current, horizon.data, eye])
  const blockerRefs = useMemo(() => [createRef<HTMLDivElement>(), createRef<HTMLDivElement>()], [])

  // Clear active measurement waypoints when switching to a different landing site.
  useEffect(() => {
    setWaypoints([])
    setSelectedWaypointId(null)
    setHoveredWaypointId(null)
    setHoveredSample(null)
  }, [siteId])

  // Re-evaluate the lunar traverse profile whenever waypoints change or finer LOLA tiles stream in.
  const measureAnalysis = useMemo(
    () => (frame ? analyseTraverse(waypoints, frame, tileHeightsRef.current, psr.data, eye) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [waypoints, frame, psr.data, eye, terrainStats],
  )

  // Keep DOM label refs stable across waypoint renames and background LOLA tile loads.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const waypointLabelRefs = useMemo(() => waypoints.map(() => createRef<HTMLDivElement>()), [waypoints.length])
  const segmentCount = measureAnalysis?.segments.length ?? 0
  const segmentLabelRefs = useMemo(
    () => Array.from({ length: segmentCount }, () => createRef<HTMLDivElement>()),
    [segmentCount],
  )
  const hoverLabelRef = useRef<HTMLDivElement>(null)
  const hasLanderWaypoint = Boolean(site && isLanderWaypointPresent(waypoints, site.lat, site.lon))

  // Keyboard shortcuts while measuring: Escape disarms, Backspace removes last waypoint.
  useEffect(() => {
    if (!measureArmed) return
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.key === 'Escape') {
        setMeasureArmed(false)
      } else if (e.key === 'Backspace' && waypoints.length > 0) {
        e.preventDefault()
        setWaypoints((prev) => reindexWaypoints(prev.slice(0, -1)))
        setHoveredWaypointId(null)
        setHoveredSample(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [measureArmed, waypoints.length])

  // Drop a pin: a click on the terrain becomes a custom site analysed by the engine.
  // Analyse a spot (a click on the terrain, or typed coordinates) as a custom site and select it.
  const analyseSpot = useCallback(
    (lat: number, lon: number) => {
      setPin({ phase: 'working', lat, lon })
      createCustomSite(lat, lon)
        .then((created) => {
          // Add it to the list in the same update that selects it: selecting an id the list
          // doesn't know yet would make the HUD fall back to the default site.
          setCreatedSites((list) => [...list.filter((x) => x.id !== created.id), created])
          setSite(created.id)
          setPin({ phase: 'idle' })
          showSnackbar(`Pin placed: ${created.name}`, 'success')
        })
        .catch((e: unknown) => {
          const message = e instanceof Error ? e.message : String(e)
          setPin({ phase: 'error', message })
          showSnackbar(`Couldn't place the pin: ${message}`, 'error')
        })
    },
    [setSite],
  )

  const deleteWaypoint = useCallback((id: string) => {
    setWaypoints((prev) => removeWaypointById(prev, id))
    setSelectedWaypointId((sel) => (sel === id ? null : sel))
    setHoveredWaypointId((hov) => (hov === id ? null : hov))
    setHoveredSample(null)
  }, [])

  const renameWaypoint = useCallback((id: string, name: string) => {
    setWaypoints((prev) => renameWaypointById(prev, id, name))
  }, [])

  const onPick = useCallback(
    (p: [number, number, number]) => {
      if (!frame) return
      const m = frame.toMoon(p)
      const [lat, lon] = vecToLatLon(m)
      if (measureArmed) {
        // Clicking near an existing waypoint on the terrain removes it and re-indexes the path.
        const hit = findNearbyWaypoint(waypoints, lat, lon, 75)
        if (hit) {
          deleteWaypoint(hit.id)
          showSnackbar(`Removed waypoint ${hit.label}${hit.name ? ` (${hit.name})` : ''}`)
          return
        }
        const heightM = Math.hypot(m[0], m[1], m[2]) - MOON_RADIUS_M
        const id = `${Date.now()}-${waypoints.length}`
        setSelectedWaypointId(id)
        setWaypoints((prev) => [
          ...prev,
          {
            id,
            label: waypointLabel(prev.length),
            lat,
            lon,
            heightM,
          },
        ])
        return
      }
      analyseSpot(lat, lon)
    },
    [frame, measureArmed, waypoints, deleteWaypoint, analyseSpot],
  )

  const startMeasureAtLander = useCallback(() => {
    if (!site) return
    if (!isLanderWaypointPresent(waypoints, site.lat, site.lon)) {
      const id = `lander-${Date.now()}`
      setSelectedWaypointId(id)
      setWaypoints((prev) =>
        reindexWaypoints([
          { id, label: 'A', name: 'Lander', lat: site.lat, lon: site.lon, heightM: site.ground_height_m },
          ...prev,
        ]),
      )
    }
    setMeasureArmed(true)
    setPin((p) => (p.phase === 'armed' ? { phase: 'idle' } : p))
    showSnackbar('Waypoint A anchored at Lander — click terrain to measure outward')
  }, [site, waypoints])

  const finestResM = terrainStats ? Math.max(5, Math.round(vertexSpacingM(terrainStats.deepest))) : null

  return (
    <div className={`absolute inset-0 overflow-hidden ${pin.phase === 'armed' ? 'pin-cursor' : measureArmed ? 'measure-cursor' : ''}`}>
      {/* Renders only when something changes (camera, time, tiles arriving): an idle view costs
          nothing. Components that animate on their own must call invalidate(). */}
      {/* A new graphics preset gets a fresh canvas: anti-aliasing is fixed when the WebGL context is made. */}
      <Canvas
        key={graphicsQuality}
        frameloop={PERF_RENDER_ALWAYS ? 'always' : 'demand'}
        dpr={gfx.dpr}
        shadows={gfx.shadows}
        gl={{ logarithmicDepthBuffer: true, antialias: gfx.antialias }}
        camera={{ position: [2600, 1400, 3400], fov: 50, near: 0.5, far: 1e9 }}
      >
        <color attach="background" args={['#000000']} />
        <ViewCentre shiftLeftPx={viewShiftPx} />
        <CameraReadout frame={frame} target={readoutRef} scaleBar={scaleBarRef} scaleLabel={scaleLabelRef} compassRing={compassRingRef} compassNorth={compassNorthRef} />
        <MiniMapTracker frame={frame} />
        {/* Display aid, not real light: a dim overhead fill so terrain in shadow still shows its
            shape. Sunlight (intensity 3 x visible fraction near the lander) stays >10x brighter. */}
        <ambientLight intensity={0.03} />
        <directionalLight position={[0, 10000, 0]} intensity={0.25} />

        {frame && (
          <TileTree
            frame={frame}
            material={terrainMaterial}
            onStats={onStats}
            onPick={pin.phase === 'armed' || measureArmed ? onPick : undefined}
            tileHeightsRef={tileHeightsRef}
            lodThresholdPx={gfx.lodThresholdPx}
            maxCachedMeshes={gfx.maxCachedMeshes}
          />
        )}
        {frame && layers.sites && <SitePins frame={frame} sites={otherSites} selectedId={siteId} />}
        {frame && layers.psr && psr.data && <PsrLayer frame={frame} data={psr.data} />}
        {frame && waypoints.length > 0 && (
          <MeasureOverlay frame={frame} waypoints={waypoints} analysis={measureAnalysis} hoveredSample={hoveredSample} />
        )}
        {layers.blockers && horizon.data && (
          <BlockerLines steps={timeline.data ?? []} current={blockers} horizon={horizon.data} eyeHeightM={eye} />
        )}
        {s && (
          <SunLight
            status={s}
            shadowHalfWidth={SHADOW_HALF_WIDTH_M}
            shadows={gfx.shadows}
            shadowMapSize={gfx.shadowMapSize}
            far={farShadows}
          />
        )}
        {/* Sky (and, in the lander's-eye views, the engine skyline) stays centred on the camera,
            like a skybox: these things are effectively at infinity. */}
        <FollowCamera>
          <Stars radius={SKY_DISTANCE_M * 0.5} depth={SKY_DISTANCE_M * 0.2} count={gfx.stars} factor={SKY_DISTANCE_M / 100} fade />
          {horizon.data && eyeView && <HorizonCurtain horizon={horizon.data} radius={CURTAIN_RADIUS_M} />}
          {s && <SkyBodies status={s} distance={SKY_DISTANCE_M} />}
          {layers.paths && timeline.data && <SkyTrails steps={timeline.data} radius={SKY_DISTANCE_M * 0.98} />}
        </FollowCamera>
        <Lander status={s} observerHeight={eye} showBeacon={view === 'overview'} detailed={gfx.detailedModels} />

        {/* Google-Earth-style: drag spins the Moon under the cursor, right-drag turns / tilts, wheel
            zooms towards the cursor. TileTree also keeps the camera itself above the ground. */}
        <GlobeControls
          moonCentre={frame?.moonCentre ?? null}
          groundRadius={MOON_RADIUS_M + (site?.ground_height_m ?? 0)}
          maxDistance={MAX_CAMERA_DISTANCE_M}
        />
        <CameraRig
          view={view}
          status={s}
          siteId={siteId}
          maxTerrainHeight={maxTerrainHeight}
          moonCentre={frame?.moonCentre ?? null}
          resetKey={cameraReset}
        />
        <ScreenLabels
          moonCentre={frame?.moonCentre ?? null}
          labels={[
            { ref: sunLabel, position: sky?.sun ?? null, followCamera: true },
            { ref: earthLabel, position: sky?.earth ?? null, followCamera: true },
            {
              ref: landerLabel,
              position: eyeView || hasLanderWaypoint ? null : [0, BEACON_HEIGHT + 10, 0],
              hideWithinM: BEACON_HIDE_WITHIN_M,
            },
            ...otherSites.map((x) => ({
              ref: siteLabelRefs.get(x.id)!,
              position: layers.sites && frame ? surfacePoint(frame, x.lat, x.lon, x.ground_height_m, 3000) : null,
              onSurface: true,
              declutter: true, // the polar sites crowd together when seen from orbit
            })),
            ...blockerRefs.map((ref, k) => ({
              ref,
              position: layers.blockers && blockers[k] ? blockers[k].to : null,
              hideBeyondM: 200_000,
            })),
            ...waypoints.map((wp, idx) => ({
              ref: waypointLabelRefs[idx],
              position: frame ? surfacePoint(frame, wp.lat, wp.lon, wp.heightM, 48) : null,
              onSurface: true,
            })),
            ...(measureAnalysis?.segments ?? []).map((seg, idx) => ({
              ref: segmentLabelRefs[idx],
              position: seg.midpointSitePos,
              onSurface: true,
            })),
            {
              ref: hoverLabelRef,
              position:
                hoveredSample && frame
                  ? surfacePoint(frame, hoveredSample.lat, hoveredSample.lon, hoveredSample.heightM, 68)
                  : null,
              onSurface: true,
            },
          ]}
        />
        {PERF_ENABLED && <PerfProbe />}
      </Canvas>
      {PERF_ENABLED && <PerfOverlay />}

      {/* Labels pinned to 3D points by <ScreenLabels> */}
      <div ref={sunLabel} className={`${labelClass} bg-black/60`}>
        {s && `Sun ${fmtDeg(s.sun.elevation_deg)} · ${fmtPct(s.sun.visible_fraction, s.sun.visible)} visible`}
      </div>
      <div ref={earthLabel} className={`${labelClass} bg-black/60`}>
        {s &&
          `Earth ${fmtDeg(s.earth.elevation_deg)} · ${
            s.earth.visible === null ? 'unknown' : s.earth.visible ? 'in view' : 'blocked'
          } (${fmtDeg(s.earth.margin_deg, 2, true)})`}
      </div>
      <div ref={landerLabel} className={`${labelClass} bg-orange-500/80 font-medium`}>
        {site?.name ?? 'Lander'}
      </div>
      {otherSites.map((x) => (
        <button
          key={x.id}
          ref={siteLabelRefs.get(x.id)}
          type="button"
          onClick={() => setSite(x.id)}
          data-tip={`${x.name}${x.approximate ? ' (approximate coordinates)' : ''}: click to select`}
          className="absolute left-0 top-0 hidden whitespace-nowrap rounded border bg-slate-950/75 px-1.5 py-0.5 text-[10px] text-slate-100 hover:bg-slate-800"
          style={{ borderColor: KIND_COLOR[x.kind ?? 'custom'] ?? KIND_COLOR.custom }}
        >
          {x.name}
          {x.approximate ? ' ≈' : ''}
        </button>
      ))}
      {blockerRefs.map((ref, k) => {
        const b = blockers[k]
        return (
          <div key={k} ref={ref} className={`${labelClass} ${b?.body === 'sun' ? 'bg-red-900/80' : 'bg-blue-900/80'}`}>
            {b &&
              `${b.body === 'sun' ? 'Sun' : 'Earth'} blocked by terrain ${fmtDistance(b.distanceM)} away (${Math.abs(
                b.marginDeg,
              ).toFixed(2)}° short)`}
          </div>
        )
      })}
      {waypoints.map((wp, idx) => {
        const isSel = wp.id === selectedWaypointId
        const isHov = wp.id === hoveredWaypointId
        return (
          <div
            key={wp.id}
            ref={waypointLabelRefs[idx]}
            onPointerEnter={() => setHoveredWaypointId(wp.id)}
            onPointerLeave={() => setHoveredWaypointId((cur) => (cur === wp.id ? null : cur))}
            onClick={() => {
              setSelectedWaypointId(wp.id)
              setMeasureDrawer('points')
            }}
            data-tip={`Waypoint ${wp.label}${wp.name ? ` (${wp.name})` : ''}: click to inspect or rename`}
            className="group pointer-events-auto absolute left-0 top-0 hidden cursor-pointer select-none"
          >
            <div
              className={`flex origin-bottom items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 font-mono text-[10px] font-bold tabular-nums text-white shadow-md transition-[transform,background-color,border-color,box-shadow] duration-150 ease-out group-hover:scale-[1.07] group-hover:shadow-lg ${
                isSel || isHov
                  ? 'scale-[1.07] border-white bg-[#ff634a] ring-2 ring-white/80'
                  : 'border-white/75 bg-slate-950/90 group-hover:border-white group-hover:bg-[#ff634a]'
              }`}
            >
              <span>
                {wp.label}
                {wp.name ? ` · ${wp.name}` : ''} · {Math.round(wp.heightM)}m
              </span>
              <button
                type="button"
                aria-label={`Delete waypoint ${wp.label}`}
                data-tip={`Delete waypoint ${wp.label}`}
                onClick={(e) => {
                  e.stopPropagation()
                  deleteWaypoint(wp.id)
                }}
                className="ml-0.5 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-black/35 text-[10px] leading-none transition-colors hover:bg-red-600"
              >
                ×
              </button>
            </div>
          </div>
        )
      })}
      {(measureAnalysis?.segments ?? []).map((seg, idx) => (
        <div
          key={`seg-${idx}`}
          ref={segmentLabelRefs[idx]}
          className="pointer-events-none absolute left-0 top-0 hidden whitespace-nowrap rounded border border-slate-600/80 bg-slate-950/85 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-slate-100"
        >
          {fmtDistance(seg.surfaceDistanceM)} · {seg.maxSlopeDeg.toFixed(1)}° max
        </div>
      ))}
      <div
        ref={hoverLabelRef}
        className="pointer-events-none absolute left-0 top-0 hidden whitespace-nowrap rounded border border-white/80 bg-slate-950/90 px-2 py-0.5 font-mono text-[10px] tabular-nums text-white shadow"
      >
        {hoveredSample &&
          `${fmtDistance(hoveredSample.distanceM)} · ${Math.round(hoveredSample.heightM)} m · ${hoveredSample.slopeDeg.toFixed(1)}°`}
      </div>

      {/* Floating UI. Containers ignore the pointer so the 3D view stays interactive around them. */}
      <div
        className="md-host pointer-events-none absolute inset-0 [--lp-side-w:clamp(280px,23.5vw,360px)]"
        style={{ fontFamily: 'var(--font-inter)' }}
      >
        <SnackbarHost />
        <TerrainLoadingOverlay />
        <TooltipHost />
        <div
          className="pointer-events-none absolute bottom-2 right-[4vw] flex flex-col items-end gap-2 text-[10px] tabular-nums text-white"
          style={{ textShadow: '0 1px 4px rgba(0,0,0,0.9)' }}
        >
          {/* Compass: white lines only. The ring turns so N points at lunar north; the notch at the top is where the camera faces. */}
          <div
            aria-label="Compass"
            role="img"
            data-tip="Compass: the ring turns as you orbit so N always points to lunar north (the Moon has no magnetic field, so this is the direction of the pole). The notch at the top is the way the camera faces; E is east, to the right when you face north."
            className="pointer-events-auto h-14 w-14 shrink-0"
          >
            <svg viewBox="0 0 56 56" width="56" height="56" fill="none" stroke="white" strokeWidth="1.25" strokeLinecap="round" style={{ filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.9))' }}>
              <path d="M28 1v5" />
              <g ref={compassRingRef}>
                <circle cx="28" cy="28" r="20" />
                <path d="M28 41v7M8 28h7M41 28h7" />
                <path d="M14 14l2 2M42 14l-2 2M14 42l2-2M42 42l-2-2" strokeWidth="0.75" />
                <path d="M25 26l3-8 3 8" />
                <text ref={compassNorthRef} x="28" y="16" textAnchor="middle" fill="white" stroke="none" fontSize="9" fontWeight="600" style={{ fontFamily: 'var(--font-inter)' }}>
                  N
                </text>
              </g>
            </svg>
          </div>
          <div className="flex flex-col items-end gap-1">
          {/* Scale bar: its width is the on-screen length of the distance in its label. */}
          <div aria-label="Map scale" className="flex flex-col items-end">
            <div ref={scaleLabelRef} />
            <div ref={scaleBarRef} className="h-1.5 border-x-2 border-b-2 border-white" style={{ width: 60 }} />
          </div>
          <div ref={readoutRef} aria-label="Camera position" className="whitespace-nowrap" />
          </div>
        </div>
        <div className="absolute left-[clamp(16px,4.5vw,65px)] top-[clamp(60px,6.2vw,92px)] max-w-[min(34rem,calc(100vw-var(--lp-side-w)-12vw))]">
          <TopInfo sites={sites.data} current={s} events={events} terrainStats={terrainStats} />
          <ColorKey layers={layers} />
        </div>
        <div ref={sideRef} className="absolute bottom-32 right-[4vw] top-[clamp(14px,2.5vw,34px)] flex w-[var(--lp-side-w)] flex-col gap-4">
          {site && (
            <MiniMapPanel
              horizon={horizon.data}
              steps={timeline.data ?? []}
              current={s}
              windowLabel={windowLabel}
              sites={sites.data}
              siteId={siteId}
              frame={frame}
            />
          )}
          <FloatingSidebar>
            <div className="space-y-4">
              <SiteSelect sites={sites.data} error={error} loading={loading} />
              {sidebar}
            </div>
          </FloatingSidebar>
        </div>
        {/* Floating + (new plan): 32 px above the timeline panel, near its right edge; drops to the corner when the panel is hidden. */}
        {fab && (
          <div
            className="md-slide pointer-events-auto absolute right-[calc(4vw+var(--lp-side-w)+16px+1vw)] transition-[bottom] duration-[400ms] ease-[var(--md-ease-emph-decel)] max-md:right-3"
            style={{ bottom: barHidden ? 24 : barNow + 32 }}
          >
            {fab}
          </div>
        )}
        {/* Bottom stack: map tools (pin / layers / JPL check) sit just above the timeline panel. */}
        <div className="absolute bottom-0 left-3 right-3 flex flex-col md:left-[3.6vw] md:right-[calc(4vw+var(--lp-side-w)+16px)]">
          <TerrainProgressBar />
          <MissionPanel mission={mission} />
          {/* Lifted above the "show timeline" arrow while the panel is hidden. */}
          <div className={`md-slide relative transition-[margin] duration-[400ms] ease-[var(--md-ease-emph-decel)] ${barHidden ? 'mb-11' : ''}`}>
            {/* Which surface data is showing, level with the toolbar at the left (wide screens). */}
            <div className="pointer-events-none absolute bottom-2 left-0 hidden h-14 items-center md:flex">
              <CoverageBadge />
            </div>
            <MapTools
              layers={layers}
              onLayers={setLayers}
              pin={pin}
              onArmPin={(armed) => {
                setPin(armed ? { phase: 'armed' } : { phase: 'idle' })
                if (armed) setMeasureArmed(false)
              }}
              onCoordinates={analyseSpot}
              siteId={siteId}
              timeUtc={timeUtc}
              view={view}
              onView={setView}
              onGoToView={() => setCameraReset((n) => n + 1)}
              graphics={graphicsQuality}
              onGraphics={setGraphicsQuality}
              farShadows={farShadows && gfx.shadows}
              farShadowsAvailable={gfx.shadows}
              onFarShadows={setFarShadows}
              mission={{ available: mission.available, active: !!mission.run, reason: mission.reason, start: mission.start, stop: mission.stop }}
              measure={{
                armed: measureArmed,
                onArm: (armed) => {
                  setMeasureArmed(armed)
                  if (armed) setPin((p) => (p.phase === 'armed' ? { phase: 'idle' } : p))
                },
                waypoints,
                selectedWaypointId,
                onSelectWaypoint: setSelectedWaypointId,
                hoveredWaypointId,
                onHoverWaypoint: setHoveredWaypointId,
                onRenameWaypoint: renameWaypoint,
                onDeleteWaypoint: deleteWaypoint,
                analysis: measureAnalysis,
                hoveredSample,
                onHoverSample: setHoveredSample,
                onStartAtLander: startMeasureAtLander,
                onUndo: () => {
                  setWaypoints((prev) => reindexWaypoints(prev.slice(0, -1)))
                  setHoveredWaypointId(null)
                  setHoveredSample(null)
                },
                onClear: () => {
                  setWaypoints([])
                  setSelectedWaypointId(null)
                  setHoveredWaypointId(null)
                  setHoveredSample(null)
                },
                onClose: () => {
                  setMeasureArmed(false)
                  setWaypoints([])
                  setSelectedWaypointId(null)
                  setHoveredWaypointId(null)
                  setHoveredSample(null)
                },
                finestResM,
                drawer: measureDrawer,
                onDrawerChange: setMeasureDrawer,
              }}
            />
          </div>
          {site && win && (
            <div
              ref={barRef}
              className={`md-slide relative transition-[transform,margin] ${
                barHidden ? 'duration-[250ms] ease-[var(--md-ease-emph-accel)]' : 'duration-[400ms] ease-[var(--md-ease-emph-decel)]'
              }`}
              style={barHidden ? { transform: `translateY(${barH}px)`, marginBottom: -barH } : undefined}
              inert={barHidden}
            >
              <TimeBar
                site={site}
                steps={timeline.data ?? []}
                win={win}
                windowDays={windowDays}
                onWindowDays={setWindowDays}
                loading={timeline.loading}
                mission={mission.strip}
                onHide={() => {
                  setBarH(barRef.current?.offsetHeight ?? 0)
                  setBarHidden(true)
                }}
              />
            </div>
          )}
          {site && win && barHidden && (
            <button
              type="button"
              onClick={() => setBarHidden(false)}
              aria-label="Show timeline panel"
              data-tip="Show timeline"
              className="md-pop pointer-events-auto absolute bottom-1 left-1/2 flex h-9 w-12 items-center justify-center text-white transition-opacity hover:opacity-70"
            >
              <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M4 14l7-7 7 7" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
