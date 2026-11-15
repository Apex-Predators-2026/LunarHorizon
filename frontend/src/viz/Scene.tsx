import { Canvas } from '@react-three/fiber'
import { createRef, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import * as THREE from 'three'
import { useAppStore } from '../store'
import type { SiteInfo, TimelineStep } from '../types'
import { createCustomSite, fetchHorizon, fetchPsr, fetchSites, fetchStatus, fetchTimeline, useAsync } from './api'
import { CameraRig, type ViewMode } from './CameraRig'
import { captureCameraPose, type CameraPose } from './cameraPose'
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
import { artemisNote, currentBlockers, fmtDistance, siteColor, surfacePoint } from './globe/overlays'
import { BlockerLines, MeasureOverlay, PsrLayer, SitePins } from './globe/SurfaceOverlays'
import { RescueMapOverlay } from '../features/rescue/RescueMapOverlay'
import type { TileHeights } from './globe/terrainHeight'
import { TileTree, type TileStats } from './globe/TileTree'
import { ColorKey, MapTools, type Layers, type PinState } from './MapTools'
import type { MeasureDrawer } from './MeasureCard'
import { HorizonCurtain } from './HorizonCurtain'
import { BEACON_HEIGHT, BEACON_HIDE_WITHIN_M, Lander } from './Lander'
import { RoverFlag, RoverFlagTag } from './RoverFlag'
import { skyPositions } from './geometry'
import { ScreenLabels } from './ScreenLabels'
import { SkyBodies } from './SkyBodies'
import { StarField } from './StarField'
import { SkyTrails } from './SkyTrails'
import { SunLight } from './SunLight'
import { EarthShine } from './EarthShine'
import { TimeBar } from './TimeBar'
import { CameraReadout } from './CameraReadout'
import { ViewCentre } from './ViewCentre'
import { fmtDeg, fmtPct, HOUR_MS, nearestIndex, parseUtc, toIsoMinute, windowFor } from './timeline'
import { FloatingSidebar } from './FloatingSidebar'
import { GRAPHICS, useGraphicsQuality, useStoredFlag, type GraphicsQuality } from './graphics'
import { MiniMapPanel } from './MiniMapPanel'
import { MiniMapTracker } from './MiniMapTracker'
import { MissionPanel } from './MissionPlayback'
import { useMissionPlayback } from './useMissionPlayback'
import { SnackbarHost } from './Snackbar'
import { TerrainLoadingOverlay, TerrainProgressBar } from './TerrainProgress'
import { CoverageBadge } from './CoverageBadge'
import { TUTORIAL_STEPS, useTutorialStore } from '../features/tutorial'
import { showSnackbar } from './snackbarStore'
import { playBubblePop, playBubbleRemove } from './sfx'
import { PERF_ENABLED, PERF_RENDER_ALWAYS } from './perf'
import { PerfOverlay, PerfProbe } from './PerfProbe'
import { HorizonProbe } from './HorizonProbe'
import { attachEvidenceViewer, clearEvidence, evidenceBand, markEvidenceProblem, markEvidenceShown, resolveEvidence, useEvidence, type ActiveEvidence } from './evidence'
import { TopInfo, useViewerSetup } from './ViewerHud'

const SHADOW_HALF_WIDTH_M = 6000 // shadow map covers ~12 km around the lander
const CURTAIN_RADIUS_M = 28000 // engine skyline (from 300 km of terrain), drawn this far out in eye views
const SKY_DISTANCE_M = 1e8 // Sun/Earth/stars well beyond the Moon, so the globe can hide them
const EYE_HIDE_LANDER_M = 15 // Sun/Earth views look out from the lander's eye: don't draw it around the camera
const MAX_CAMERA_DISTANCE_M = 8_000_000

// Hourly timeline windows already fetched (or being fetched), so the next one can be prefetched while
// playing and going back to a window is instant. Static data, so a small cache is enough.
const timelineCache = new Map<string, Promise<TimelineStep[]>>()
const TIMELINE_CACHE_SIZE = 6
function cachedTimeline(siteId: string, start: number, end: number): Promise<TimelineStep[]> {
  const key = `${siteId}|${start}|${end}`
  let p = timelineCache.get(key)
  if (p) {
    timelineCache.delete(key) // most recently used last
    timelineCache.set(key, p)
    return p
  }
  p = fetchTimeline(siteId, toIsoMinute(start), toIsoMinute(end + HOUR_MS), 1)
  p.catch(() => timelineCache.delete(key)) // a failure isn't kept: asked for again next time
  timelineCache.set(key, p)
  while (timelineCache.size > TIMELINE_CACHE_SIZE) timelineCache.delete(timelineCache.keys().next().value!)
  return p
}

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
  // The Moon's spin axis (towards the north pole) in that frame: "north-up" for the top-down view.
  const moonAxis = useMemo((): [number, number, number] | null => (frame ? [frame.east[2], frame.up[2], -frame.north[2]] : null), [frame])
  // The side panels cover the right of the view: shift the picture so the Moon/lander sits in the
  // middle of the free area to their left (half the panels' width, re-measured on resize).
  const sideRef = useRef<HTMLDivElement>(null)
  const [cameraReset, setCameraReset] = useState(0)
  // "Show me why" (evidence.ts): a request is taken when it arrives, or on mount if it was made on another page
  // before this view existed. Playback pauses at once; the site and moment are applied once the site list is
  // known, and a newer request replaces one still waiting. The camera turns only for an explicit request.
  const [pendingEvidence, setPendingEvidence] = useState<ActiveEvidence | null>(null)
  useEffect(
    () =>
      attachEvidenceViewer((r) => {
        useAppStore.getState().setPlaying(false)
        setPendingEvidence(r)
      }),
    [],
  )
  useEffect(() => {
    if (!pendingEvidence) return
    const res = resolveEvidence(pendingEvidence, sites.data, sites.error ? String(sites.error) : null)
    if (res.status === 'wait') return
    setPendingEvidence(null)
    if (res.status === 'error') {
      markEvidenceProblem(pendingEvidence, res.message)
      return
    }
    const app = useAppStore.getState()
    app.setPlaying(false)
    app.setSite(pendingEvidence.siteId)
    app.setTime(res.timeUtc)
    setView(pendingEvidence.body) // from the lander towards the Sun / Earth: the blocker line shows the terrain
    setCameraReset((n) => n + 1)
    markEvidenceShown(res.note ? { ...pendingEvidence, note: res.note } : pendingEvidence)
  }, [pendingEvidence, sites.data, sites.error])
  const evidence = useEvidence((st) => st.highlight)
  const evidenceStrip = useMemo(() => evidenceBand(evidence, siteId), [evidence, siteId])
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
  const canvasGetRef = useRef<(() => { camera: THREE.Camera; controls: unknown }) | null>(null)
  // The live canvas element. A replaced canvas is force-lost by react-three-fiber when it unmounts; that
  // late 'webglcontextlost' must not raise the "graphics card dropped the view" popup.
  const liveCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const pendingCameraPoseRef = useRef<CameraPose | null>(null)
  const handleGraphicsChange = useCallback(
    (next: GraphicsQuality) => {
      if (next === graphicsQuality) return
      const state = canvasGetRef.current?.()
      if (state) {
        pendingCameraPoseRef.current = captureCameraPose(
          state.camera,
          state.controls as { target: THREE.Vector3 } | null,
        )
      }
      setGraphicsQuality(next)
    },
    [graphicsQuality, setGraphicsQuality],
  )
  const gfx = GRAPHICS[graphicsQuality]
  // WebGL context loss (see the Canvas' onCreated): a new canvas generation remounts it.
  const [contextLost, setContextLost] = useState(false)
  const [canvasGen, setCanvasGen] = useState(0)
  const remountCanvas = useCallback(() => {
    setContextLost(false)
    setCanvasGen((g) => g + 1)
  }, [])
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
    cachedTimeline(site!.id, win![0], win![1]).then((d) => {
      if (sig.aborted) throw new DOMException('aborted', 'AbortError') // a newer window was asked for
      return d
    }),
  )
  // Playing towards the end of this window: fetch the next one now, so crossing into it is seamless.
  const nextWin =
    site && win && inRange && win[1] - now < 24 * HOUR_MS && win[1] < parseUtc(site.data_stop_utc)
      ? windowFor(win[1] + HOUR_MS, parseUtc(site.data_start_utc), parseUtc(site.data_stop_utc), windowDays)
      : null
  const nextKey = nextWin && site ? `${site.id}|${nextWin[0]}|${nextWin[1]}` : null
  useEffect(() => {
    if (nextKey && nextWin && site) cachedTimeline(site.id, nextWin[0], nextWin[1]).catch(() => {})
    // nextKey captures site and window.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextKey])
  const stepTimes = useMemo(() => (timeline.data ?? []).map((s) => parseUtc(s.time_utc)), [timeline.data])
  const i = nearestIndex(stepTimes, now)
  const fresh = i >= 0 && Math.abs(stepTimes[i] - now) <= HOUR_MS ? timeline.data![i] : null
  // While the next window loads, keep the last step (same site) instead of none: otherwise the Sun,
  // its light and the sky would unmount and remount (shadows and shaders rebuilt) at every window edge.
  const lastStep = useRef<{ siteId: string; step: TimelineStep } | null>(null)
  if (fresh && site) lastStep.current = { siteId: site.id, step: fresh }
  const current =
    fresh ?? (timeline.loading && inRange && site && lastStep.current?.siteId === site.id ? lastStep.current.step : null)

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
  // Starting mission playback leaves the evidence view; until then the evidence and mission bands are both drawn.
  const startMission = () => {
    clearEvidence()
    mission.start()
  }
  const barRef = useRef<HTMLDivElement>(null)
  const [barHidden, setBarHidden] = useState(false)
  const [barH, setBarH] = useState(0)
  const [barNow, setBarNow] = useState(0) // live height of the timeline panel, so the + button sits just above it
  // Live height of the map-tools toolbar. Below md the + button shares the bottom strip with the toolbar (which wraps
  // to two rows on a phone), so there it sits above the toolbar instead of over it.
  const toolsRef = useRef<HTMLDivElement>(null)
  const [toolsNow, setToolsNow] = useState(0)
  useEffect(() => {
    const bar = toolsRef.current?.querySelector<HTMLElement>('[role="toolbar"]')
    if (!bar || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setToolsNow(bar.offsetHeight))
    ro.observe(bar)
    return () => ro.disconnect()
  }, [])
  const aboveTools = (barHidden ? 44 : barNow) + 8 + toolsNow + 16
  useEffect(() => {
    let lastNonce = -1
    const sync = () => {
      const st = useTutorialStore.getState()
      if (!st.open || st.prepNonce === lastNonce) return
      lastNonce = st.prepNonce
      if (TUTORIAL_STEPS[st.stepIndex]?.prep?.showTimeBar) setBarHidden(false)
    }
    const id = setTimeout(sync, 0)
    const unsub = useTutorialStore.subscribe(sync)
    return () => {
      clearTimeout(id)
      unsub()
    }
  }, [])

  const sunLabel = useRef<HTMLDivElement>(null)
  const earthLabel = useRef<HTMLDivElement>(null)
  const landerLabel = useRef<HTMLDivElement>(null)
  const flagRef = useRef<HTMLDivElement>(null)
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
        playBubbleRemove()
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
    playBubbleRemove()
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
        playBubblePop(waypoints.length)
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
      playBubblePop(0)
      analyseSpot(lat, lon)
    },
    [frame, measureArmed, waypoints, deleteWaypoint, analyseSpot],
  )

  const startMeasureAtLander = useCallback(() => {
    if (!site) return
    playBubblePop(0)
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
    showSnackbar('Waypoint A anchored at Lander - click terrain to measure outward')
  }, [site, waypoints])

  const finestResM = terrainStats ? Math.max(5, Math.round(vertexSpacingM(terrainStats.deepest))) : null


  // The clickable site labels sit on top of the canvas: a wheel (or trackpad pinch) over one still
  // zooms the 3D view, as if the label weren't there. Native and non-passive, so a pinch over a label
  // doesn't zoom the page instead.
  const sceneRef = useRef<HTMLDivElement>(null)
  const dragStartRef = useRef<{ x: number; y: number } | null>(null)
  useEffect(() => {
    const root = sceneRef.current
    if (!root) return
    const onWheel = (e: WheelEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest('[data-site-label]')) return
      e.preventDefault()
      root.querySelector('canvas')?.dispatchEvent(
        new WheelEvent('wheel', {
          deltaX: e.deltaX,
          deltaY: e.deltaY,
          deltaZ: e.deltaZ,
          deltaMode: e.deltaMode,
          clientX: e.clientX,
          clientY: e.clientY,
          ctrlKey: e.ctrlKey,
          shiftKey: e.shiftKey,
          bubbles: true,
          cancelable: true,
        }),
      )
    }
    root.addEventListener('wheel', onWheel, { passive: false })
    return () => root.removeEventListener('wheel', onWheel)
  }, [])

  return (
    <div
      ref={sceneRef}
      data-testid="scene"
      data-view={view}
      data-site={siteId ?? ''}
      data-time={timeUtc}
      data-playing={playing ? 'true' : 'false'}
      onPointerDownCapture={(e) => {
        if ((e.target as HTMLElement).tagName === 'CANVAS') {
          dragStartRef.current = { x: e.clientX, y: e.clientY }
        } else {
          dragStartRef.current = null
        }
      }}
      onPointerUpCapture={(e) => {
        const start = dragStartRef.current
        dragStartRef.current = null
        if (start && pin.phase === 'idle' && !measureArmed) {
          if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) {
            useTutorialStore.getState().recordInteraction('orbit-3d')
          }
        }
      }}
      className={`absolute inset-0 select-none overflow-hidden [&_input]:select-text [&_textarea]:select-text ${pin.phase === 'armed' ? 'pin-cursor' : measureArmed ? 'measure-cursor' : ''}`}
    >
      {/* Renders only when something changes (camera, time, tiles arriving): an idle view costs
          nothing. Components that animate on their own must call invalidate(). */}
      {/* A new graphics preset gets a fresh canvas: anti-aliasing is fixed when the WebGL context is made. */}
      {contextLost && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/80 p-4">
          <div className="max-w-sm rounded-lg border border-slate-700 bg-slate-900 p-4 text-center text-sm text-slate-200">
            <p className="mb-3">
              The graphics card dropped the 3D view (WebGL context lost, often low GPU memory). Lower the graphics
              setting if this repeats.
            </p>
            <button
              type="button"
              className="rounded bg-amber-500 px-3 py-1.5 font-medium text-slate-950 hover:bg-amber-400"
              onClick={remountCanvas}
            >
              Reload 3D view
            </button>
          </div>
        </div>
      )}
      <Canvas
        key={`${graphicsQuality}-${canvasGen}`}
        frameloop={PERF_RENDER_ALWAYS ? 'always' : 'demand'}
        dpr={gfx.dpr}
        shadows={gfx.shadows}
        gl={{ logarithmicDepthBuffer: true, antialias: gfx.antialias }}
        camera={{ position: pendingCameraPoseRef.current?.position ?? [2600, 1400, 3400], fov: 50, near: 0.5, far: 1e9 }}
        onCreated={({ camera, get, gl }) => {
          canvasGetRef.current = get
          // GPU out of memory, driver reset, etc.: say so and offer a fresh canvas (kept camera pose)
          // instead of a frozen black view. A restored context also gets a fresh canvas: three's
          // own restore doesn't bring back every buffer and texture reliably.
          const el = gl.domElement
          liveCanvasRef.current = el
          el.addEventListener(
            'webglcontextlost',
            (e) => {
              if (liveCanvasRef.current !== el || !el.isConnected) return // an old canvas being disposed, not a real loss
              e.preventDefault() // allow the browser to restore it
              const st = get()
              pendingCameraPoseRef.current = captureCameraPose(st.camera, st.controls as { target: THREE.Vector3 } | null)
              setContextLost(true)
            },
            { once: true },
          )
          el.addEventListener(
            'webglcontextrestored',
            () => {
              if (liveCanvasRef.current === el && el.isConnected) remountCanvas()
            },
            { once: true },
          )
          const pose = pendingCameraPoseRef.current
          if (pose) {
            camera.position.set(...pose.position)
            camera.quaternion.set(...pose.quaternion)
            camera.up.set(...pose.up)
            camera.updateMatrixWorld()
          }
        }}
      >
        <color attach="background" args={['#000000']} />
        <ViewCentre shiftLeftPx={viewShiftPx} />
        <CameraReadout frame={frame} target={readoutRef} scaleBar={scaleBarRef} scaleLabel={scaleLabelRef} compassRing={compassRingRef} compassNorth={compassNorthRef} />
        <MiniMapTracker frame={frame} />
        {/* Faint earthshine (display aid, see EarthShine.tsx) instead of an overhead fill that was
            brighter than the low polar Sun and made shadowed craters look lit. */}
        <EarthShine status={s} />

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
        {frame && <RescueMapOverlay frame={frame} sites={sites.data ?? []} />}
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
          <StarField frame={frame} timeUtc={s?.time_utc ?? null} radius={SKY_DISTANCE_M * 0.95} count={gfx.stars} />
          {horizon.data && eyeView && <HorizonCurtain horizon={horizon.data} radius={CURTAIN_RADIUS_M} />}
          {s && <SkyBodies status={s} distance={SKY_DISTANCE_M} frame={frame} />}
          {layers.paths && timeline.data && <SkyTrails steps={timeline.data} radius={SKY_DISTANCE_M * 0.98} />}
        </FollowCamera>
        <Lander
          status={s}
          observerHeight={eye}
          showBeacon={view === 'overview'}
          detailed={gfx.detailedModels}
          hideWithinM={eyeView ? EYE_HIDE_LANDER_M : 0}
        />
        <RoverFlag flagRef={flagRef} status={s} frame={frame} tileHeightsRef={tileHeightsRef} />

        {/* Google-Earth-style: drag spins the Moon under the cursor, right-drag turns / tilts, wheel
            zooms towards the cursor. TileTree also keeps the camera itself above the ground. */}
        <GlobeControls
          moonCentre={frame?.moonCentre ?? null}
          moonAxis={moonAxis}
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
          restorePoseRef={pendingCameraPoseRef}
          eyeHeightM={eye}
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
        {PERF_ENABLED && <HorizonProbe eyeHeightM={eye} />}
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
      <RoverFlagTag ref={flagRef} />
      <div ref={landerLabel} className={`${labelClass} bg-orange-500/80 font-medium`}>
        {site?.name ?? 'Lander'}
      </div>
      {otherSites.map((x) => (
        <button
          key={x.id}
          ref={siteLabelRefs.get(x.id)}
          type="button"
          data-site-label
          data-no-sfx
          onClick={() => {
            playBubblePop(0)
            setSite(x.id)
          }}
          data-tip={`${x.name}${x.approximate ? ' (approximate coordinates)' : ''}: click to select${artemisNote(x) ? `. ${artemisNote(x)}.` : ''}`}
          className="absolute left-0 top-0 hidden whitespace-nowrap rounded border bg-slate-950/75 px-1.5 py-0.5 text-[10px] text-slate-100 hover:bg-slate-800"
          style={{ borderColor: siteColor(x) }}
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
              playBubblePop(idx)
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
                data-no-sfx
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
        className="ui-chrome md-host pointer-events-none absolute inset-0 z-[2] [--lp-side-w:clamp(280px,23.5vw,360px)]"
        style={{ fontFamily: 'var(--font-inter)' }}
      >
        <SnackbarHost />
        <TerrainLoadingOverlay />
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
          <CoverageBadge />
          </div>
        </div>
        <div className="absolute left-[clamp(16px,4.5vw,65px)] top-[clamp(104px,7.2vw,136px)] max-w-[min(34rem,calc(100vw-var(--lp-side-w)-12vw))]">
          <TopInfo sites={sites.data} current={s} events={events} terrainStats={terrainStats} />
          <ColorKey layers={layers} />
        </div>
        {/* On viewports narrower than ~1760 px the navigation row (tabs + "Try a mission") reaches over this column, so
            the column starts below the header there (at 1366x768 the Map/Sky tabs used to cover "Methodology"). */}
        <div ref={sideRef} className="absolute bottom-44 right-[4vw] top-[clamp(14px,2.5vw,34px)] flex w-[var(--lp-side-w)] flex-col gap-4 max-[1760px]:top-[100px]">
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
            <div className="space-y-4">{sidebar}</div>
          </FloatingSidebar>
        </div>
        {/* Floating + (new plan): 32 px above the timeline panel, near its right edge; drops to the corner when the panel is hidden. */}
        {fab && (
          <div
            className={`md-slide pointer-events-auto absolute bottom-[var(--fab-b)] right-[calc(4vw+var(--lp-side-w)+16px+1vw)] transition-[bottom] max-md:bottom-[var(--fab-b-sm)] max-md:right-3 ${
              // Same duration and easing as the timeline panel, so the two slide together.
              barHidden ? 'duration-[250ms] ease-[var(--md-ease-emph-accel)]' : 'duration-[400ms] ease-[var(--md-ease-emph-decel)]'
            }`}
            style={{
              // Desktop: 32 px above the timeline panel (24 px from the corner when it is hidden). Where the + shares the
              // strip with the toolbar (below md, or any width where the toolbar has wrapped to a second row, e.g. a
              // tablet): 16 px above the toolbar, which sits 8 px above the panel (44 px up when the panel is hidden).
              ['--fab-b' as string]: `${toolsNow > 64 ? aboveTools : barHidden ? 24 : barNow + 32}px`,
              ['--fab-b-sm' as string]: `${aboveTools}px`,
            }}
          >
            {fab}
          </div>
        )}
        {/* Bottom stack: map tools (pin / layers / JPL check) sit just above the timeline panel. */}
        <div className="absolute bottom-0 left-3 right-3 flex flex-col md:left-[3.6vw] md:right-[calc(4vw+var(--lp-side-w)+16px)]">
          <TerrainProgressBar />
          <MissionPanel mission={mission} />
          {/* Lifted above the "show timeline" arrow while the panel is hidden. */}
          <div ref={toolsRef} className={`md-slide relative transition-[margin] duration-[400ms] ease-[var(--md-ease-emph-decel)] ${barHidden ? 'mb-11' : ''}`}>
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
              sites={sites.data}
              sitesError={error}
              sitesLoading={loading}
              timeUtc={timeUtc}
              view={view}
              onView={setView}
              onGoToView={() => setCameraReset((n) => n + 1)}
              graphics={graphicsQuality}
              onGraphics={handleGraphicsChange}
              farShadows={farShadows && gfx.shadows}
              farShadowsAvailable={gfx.shadows}
              onFarShadows={setFarShadows}
              mission={{ available: mission.available, active: !!mission.run, reason: mission.reason, start: startMission, stop: mission.stop }}
              measure={{
                armed: measureArmed,
                onArm: (armed) => {
                  setMeasureArmed(armed)
                  if (armed) setPin((p) => (p.phase === 'armed' ? { phase: 'idle' } : p))
                },
                waypoints,
                selectedWaypointId,
                onSelectWaypoint: (id) => {
                  if (id) playBubblePop(0)
                  setSelectedWaypointId(id)
                },
                hoveredWaypointId,
                onHoverWaypoint: setHoveredWaypointId,
                onRenameWaypoint: renameWaypoint,
                onDeleteWaypoint: deleteWaypoint,
                analysis: measureAnalysis,
                hoveredSample,
                onHoverSample: setHoveredSample,
                onStartAtLander: startMeasureAtLander,
                onUndo: () => {
                  playBubbleRemove()
                  setWaypoints((prev) => reindexWaypoints(prev.slice(0, -1)))
                  setHoveredWaypointId(null)
                  setHoveredSample(null)
                },
                onClear: () => {
                  playBubbleRemove()
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
              data-tour="time-bar"
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
                evidence={evidenceStrip}
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
