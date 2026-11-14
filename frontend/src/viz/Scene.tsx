import { OrbitControls, Stars } from '@react-three/drei'
import { Canvas } from '@react-three/fiber'
import { createRef, useCallback, useMemo, useRef, useState, type RefObject } from 'react'
import * as THREE from 'three'
import { useAppStore } from '../store'
import type { SiteInfo } from '../types'
import { createCustomSite, fetchHorizon, fetchPsr, fetchSites, fetchStatus, fetchTimeline, useAsync } from './api'
import { CameraRig, type ViewMode } from './CameraRig'
import { FollowCamera } from './FollowCamera'
import { SiteFrame, vecToLatLon } from './globe/cubeSphere'
import { currentBlockers, fmtDistance, KIND_COLOR, surfacePoint } from './globe/overlays'
import { BlockerLines, PsrLayer, SitePins } from './globe/SurfaceOverlays'
import { TileTree, type TileStats } from './globe/TileTree'
import { MapTools, type Layers, type PinState } from './MapTools'
import { HorizonCurtain } from './HorizonCurtain'
import { BEACON_HEIGHT, BEACON_HIDE_WITHIN_M, Lander } from './Lander'
import { skyPositions } from './geometry'
import { ScreenLabels } from './ScreenLabels'
import { SkyBodies } from './SkyBodies'
import { SkyPlot } from './SkyPlot'
import { SunLight } from './SunLight'
import { TimeBar } from './TimeBar'
import { fmtDeg, fmtPct, HOUR_MS, nearestIndex, parseUtc, toIsoMinute, windowFor } from './timeline'
import { ViewerHud } from './ViewerHud'

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
export function Scene() {
  const siteId = useAppStore((s) => s.siteId)
  const timeUtc = useAppStore((s) => s.timeUtc)
  const playing = useAppStore((s) => s.playing)
  const [view, setView] = useState<ViewMode>('overview')
  const [windowDays, setWindowDays] = useState(14)
  const [terrainStats, setTerrainStats] = useState<TileStats | null>(null)
  const [layers, setLayers] = useState<Layers>({ sites: true, psr: true, blockers: true })
  const [pin, setPin] = useState<PinState>({ phase: 'idle' })
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
  const terrainMaterial = useMemo(() => new THREE.MeshStandardMaterial({ color: '#9a9a9a', roughness: 0.95 }), [])
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
      prev && prev.visible === s.visible && prev.loading === s.loading && prev.deepest === s.deepest ? prev : s,
    )
  }, [])

  // Hourly data for the window containing the selected time. Playback reads from this, so it only
  // refetches when it crosses into the next window.
  const now = parseUtc(timeUtc)
  const win: [number, number] | null = site
    ? windowFor(now, parseUtc(site.data_start_utc), parseUtc(site.data_stop_utc), windowDays)
    : null
  const winKey = site && win && inRange ? `${site.id}|${win[0]}|${win[1]}` : null
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

  // Drop a pin: a click on the terrain becomes a custom site analysed by the engine.
  const onPick = useCallback(
    (p: [number, number, number]) => {
      if (!frame) return
      const [lat, lon] = vecToLatLon(frame.toMoon(p))
      setPin({ phase: 'working', lat, lon })
      createCustomSite(lat, lon)
        .then((created) => {
          // Add it to the list in the same update that selects it: selecting an id the list
          // doesn't know yet would make the HUD fall back to the default site.
          setCreatedSites((list) => [...list.filter((x) => x.id !== created.id), created])
          setSite(created.id)
          setPin({ phase: 'idle' })
        })
        .catch((e: unknown) => setPin({ phase: 'error', message: e instanceof Error ? e.message : String(e) }))
    },
    [frame, setSite],
  )

  return (
    <div className="absolute inset-0 overflow-hidden">
      <Canvas
        shadows
        gl={{ logarithmicDepthBuffer: true, antialias: true }}
        camera={{ position: [2600, 1400, 3400], fov: 50, near: 0.5, far: 1e9 }}
      >
        <color attach="background" args={['#000000']} />
        {/* Display aid, not real light: a dim overhead fill so terrain in shadow still shows its
            shape. Sunlight (intensity 3 x visible fraction near the lander) stays >10x brighter. */}
        <ambientLight intensity={0.03} />
        <directionalLight position={[0, 10000, 0]} intensity={0.25} />

        {frame && (
          <TileTree
            frame={frame}
            material={terrainMaterial}
            onStats={onStats}
            onPick={pin.phase === 'armed' ? onPick : undefined}
          />
        )}
        {frame && layers.sites && <SitePins frame={frame} sites={otherSites} selectedId={siteId} />}
        {frame && layers.psr && psr.data && <PsrLayer frame={frame} data={psr.data} />}
        {layers.blockers && horizon.data && (
          <BlockerLines steps={timeline.data ?? []} current={blockers} horizon={horizon.data} eyeHeightM={eye} />
        )}
        {s && <SunLight status={s} shadowHalfWidth={SHADOW_HALF_WIDTH_M} />}
        {/* Sky (and, in the lander's-eye views, the engine skyline) stays centred on the camera,
            like a skybox: these things are effectively at infinity. */}
        <FollowCamera>
          <Stars radius={SKY_DISTANCE_M * 0.5} depth={SKY_DISTANCE_M * 0.2} count={4000} factor={SKY_DISTANCE_M / 100} fade />
          {horizon.data && eyeView && <HorizonCurtain horizon={horizon.data} radius={CURTAIN_RADIUS_M} />}
          {s && <SkyBodies status={s} distance={SKY_DISTANCE_M} />}
        </FollowCamera>
        <Lander status={s} observerHeight={eye} showBeacon={view === 'overview'} />

        <OrbitControls minDistance={5} maxDistance={MAX_CAMERA_DISTANCE_M} makeDefault />
        <CameraRig
          view={view}
          status={s}
          siteId={siteId}
          maxTerrainHeight={maxTerrainHeight}
          moonCentre={frame?.moonCentre ?? null}
        />
        <ScreenLabels
          moonCentre={frame?.moonCentre ?? null}
          labels={[
            { ref: sunLabel, position: sky?.sun ?? null, followCamera: true },
            { ref: earthLabel, position: sky?.earth ?? null, followCamera: true },
            {
              ref: landerLabel,
              position: eyeView ? null : [0, BEACON_HEIGHT + 10, 0],
              hideWithinM: BEACON_HIDE_WITHIN_M,
            },
            ...otherSites.map((x) => ({
              ref: siteLabelRefs.get(x.id)!,
              position: layers.sites && frame ? surfacePoint(frame, x.lat, x.lon, x.ground_height_m, 3000) : null,
              onSurface: true,
            })),
            ...blockerRefs.map((ref, k) => ({
              ref,
              position: layers.blockers && blockers[k] ? blockers[k].to : null,
              hideBeyondM: 200_000,
            })),
          ]}
        />
      </Canvas>

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
          title={`${x.name}${x.approximate ? ' (approximate coordinates)' : ''}: click to select`}
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

      <MapTools
        layers={layers}
        onLayers={setLayers}
        pin={pin}
        onArmPin={(armed) => setPin(armed ? { phase: 'armed' } : { phase: 'idle' })}
        siteId={siteId}
        timeUtc={timeUtc}
      />

      <ViewerHud
        sites={sites.data}
        current={s}
        events={events}
        error={error}
        loading={loading}
        view={view}
        onView={setView}
        terrainStats={terrainStats}
      />
      {site && (
        <div className="pointer-events-auto absolute right-3 top-3 w-[236px] rounded-md border border-slate-700 bg-slate-950/80 p-2 backdrop-blur">
          <SkyPlot horizon={horizon.data} steps={timeline.data ?? []} current={s} windowLabel={windowLabel} />
        </div>
      )}
      {site && win && (
        <TimeBar
          site={site}
          steps={timeline.data ?? []}
          win={win}
          windowDays={windowDays}
          onWindowDays={setWindowDays}
          loading={timeline.loading}
        />
      )}
    </div>
  )
}
