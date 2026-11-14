import { OrbitControls, Stars } from '@react-three/drei'
import { Canvas } from '@react-three/fiber'
import { useRef, useState } from 'react'
import { useAppStore } from '../store'
import { fetchHorizon, fetchSites, fetchStatus, fetchTerrain, useAsync } from './api'
import { CameraRig, type ViewMode } from './CameraRig'
import { FollowCamera } from './FollowCamera'
import { HorizonCurtain } from './HorizonCurtain'
import { BEACON_HEIGHT, BEACON_HIDE_WITHIN_M, Lander } from './Lander'
import { skyPositions } from './geometry'
import { ScreenLabels } from './ScreenLabels'
import { SkyBodies } from './SkyBodies'
import { SunLight } from './SunLight'
import { Terrain } from './Terrain'
import { ViewerHud } from './ViewerHud'

const TERRAIN_HALF_WIDTH_M = 5000 // 10 x 10 km of LOLA terrain around the site
const CURTAIN_RADIUS_M = 28000 // computed horizon (from 300 km of terrain) drawn this far out
const SKY_DISTANCE_M = 30000 // Sun/Earth sit just beyond the curtain

const labelClass =
  'pointer-events-none absolute left-0 top-0 hidden whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] text-slate-100'

/**
 * 3D view of the selected site at the selected time. Everything shown comes from the backend:
 * terrain grid, horizon mask, and Sun/Earth status, so the view matches the charts.
 */
export function Scene() {
  const siteId = useAppStore((s) => s.siteId)
  const timeUtc = useAppStore((s) => s.timeUtc)
  const [view, setView] = useState<ViewMode>('overview')

  const sites = useAsync('sites', (sig) => fetchSites(sig))
  const site = sites.data?.find((s) => s.id === siteId) ?? null
  const inRange = !!site && timeUtc >= site.data_start_utc && timeUtc <= site.data_stop_utc

  const terrain = useAsync(site ? site.id : null, (sig) => fetchTerrain(site!.id, TERRAIN_HALF_WIDTH_M, 256, sig))
  const horizon = useAsync(site ? site.id : null, (sig) => fetchHorizon(site!.id, sig))
  const status = useAsync(inRange ? `${site!.id}@${timeUtc}` : null, (sig) => fetchStatus(site!.id, timeUtc, sig))

  const eye = site?.observer_height_m ?? 2
  const error = sites.error ?? terrain.error ?? horizon.error ?? status.error
  const loading = sites.loading || terrain.loading || horizon.loading || status.loading

  const sunLabel = useRef<HTMLDivElement>(null)
  const earthLabel = useRef<HTMLDivElement>(null)
  const landerLabel = useRef<HTMLDivElement>(null)
  const sky = status.data ? skyPositions(status.data, SKY_DISTANCE_M, 0) : null // relative to the camera
  const s = status.data

  return (
    <div className="absolute inset-0 overflow-hidden">
      <Canvas
        shadows
        gl={{ logarithmicDepthBuffer: true, antialias: true }}
        camera={{ position: [2600, 1400, 3400], fov: 50, near: 0.5, far: 200000 }}
      >
        <color attach="background" args={['#000000']} />
        <Stars radius={60000} depth={20000} count={4000} factor={600} fade />
        {/* Display aid, not real light: a dim overhead fill so terrain in shadow still shows its
            shape. Sunlight (intensity 3 x visible fraction) stays >10x brighter. */}
        <ambientLight intensity={0.03} />
        <directionalLight position={[0, 10000, 0]} intensity={0.25} />

        {terrain.data && <Terrain grid={terrain.data} />}
        {s && <SunLight status={s} shadowHalfWidth={TERRAIN_HALF_WIDTH_M * 1.2} />}
        {/* Distant horizon + Sun/Earth stay centred on the camera, like a skybox. Exact from the
            lander views; from a high overview camera the skyline is approximate (it was computed
            from the lander's eye). */}
        <FollowCamera>
          {horizon.data && <HorizonCurtain horizon={horizon.data} radius={CURTAIN_RADIUS_M} />}
          {s && <SkyBodies status={s} distance={SKY_DISTANCE_M} />}
        </FollowCamera>
        <Lander status={s} observerHeight={eye} showBeacon={view === 'overview'} />

        <OrbitControls minDistance={5} maxDistance={CURTAIN_RADIUS_M * 0.5} makeDefault />
        <CameraRig
          view={view}
          status={s}
          siteId={siteId}
          maxTerrainHeight={terrain.data ? terrain.data.max_height_m - terrain.data.site_height_m : null}
        />
        <ScreenLabels
          labels={[
            { ref: sunLabel, position: sky?.sun ?? null, followCamera: true },
            { ref: earthLabel, position: sky?.earth ?? null, followCamera: true },
            {
              ref: landerLabel,
              position: view === 'overview' ? [0, BEACON_HEIGHT + 10, 0] : null,
              hideWithinM: BEACON_HIDE_WITHIN_M,
            },
          ]}
        />
      </Canvas>

      {/* Labels pinned to 3D points by <ScreenLabels> */}
      <div ref={sunLabel} className={`${labelClass} bg-black/60`}>
        {s && `Sun ${s.sun.elevation_deg.toFixed(2)}° · ${Math.round(s.sun.visible_fraction * 100)}% visible`}
      </div>
      <div ref={earthLabel} className={`${labelClass} bg-black/60`}>
        {s &&
          `Earth ${s.earth.elevation_deg.toFixed(2)}° · ${s.earth.visible ? 'in view' : 'blocked'} (${
            s.earth.margin_deg >= 0 ? '+' : ''
          }${s.earth.margin_deg.toFixed(2)}°)`}
      </div>
      <div ref={landerLabel} className={`${labelClass} bg-orange-500/80 font-medium`}>
        Lander
      </div>

      <ViewerHud sites={sites.data} status={s} error={error} loading={loading} view={view} onView={setView} />
    </div>
  )
}
