// Floating toolbar over the 3D view (M3 "floating toolbar"): camera menu, layers menu (switches),
// drop pin (click the terrain or type coordinates), verify with JPL, and play / pause. Messages, the legend and the JPL result open above it.
// Its menus float over whatever is above the toolbar (which steps back meanwhile: `recede-behind-menu`, index.css)
// instead of pushing it up the screen.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useAppStore } from '../store'
import type { VerifyResult } from '../types'
import { fetchVerify } from './api'
import { showSnackbar } from './snackbarStore'
import { useUiPrefs } from './uiPrefs'
import type { ViewMode } from './CameraRig'
import { InteractiveGrainGradient } from '../ui/InteractiveGrainGradient'
import type { MeasureAnalysis, MeasureWaypoint, ProfileSample } from './globe/measure'
import { ARTEMIS_FORMER_COLOR, KIND_COLOR } from './globe/overlays'
import { parseCoordinates } from './coordinates'
import { GRAPHICS, type GraphicsQuality } from './graphics'
import { JplHorizonsCard } from './JplHorizonsCard'
import { toggleTopDown, useCameraTilt } from './cameraTilt'
import { MeasureCard, type MeasureDrawer } from './MeasureCard'
import { SiteMenuRows } from './ViewerHud'
import type { SiteInfo } from '../types'
import { useTutorialStore } from '../features/tutorial'
import { TextField } from '../ui/MdFields'

export interface MeasureController {
  armed: boolean
  onArm: (armed: boolean) => void
  waypoints: MeasureWaypoint[]
  selectedWaypointId: string | null
  onSelectWaypoint: (id: string | null) => void
  hoveredWaypointId: string | null
  onHoverWaypoint: (id: string | null) => void
  onRenameWaypoint: (id: string, name: string) => void
  onDeleteWaypoint: (id: string) => void
  analysis: MeasureAnalysis | null
  hoveredSample: ProfileSample | null
  onHoverSample: (s: ProfileSample | null) => void
  onStartAtLander: () => void
  onUndo: () => void
  onClear: () => void
  onClose: () => void
  finestResM: number | null
  drawer: MeasureDrawer
  onDrawerChange: (d: MeasureDrawer) => void
}

export interface Layers {
  sites: boolean
  psr: boolean
  blockers: boolean
  paths: boolean // the Sun's and Earth's paths across the sky over the time window
}

export type PinState =
  | { phase: 'idle' }
  | { phase: 'armed' }
  | { phase: 'working'; lat: number; lon: number }
  | { phase: 'error'; message: string }

const VIEWS: { id: ViewMode; label: string; hint: string }[] = [
  { id: 'globe', label: 'Globe', hint: 'The whole Moon' },
  { id: 'region', label: 'Region', hint: 'A few hundred km around the site' },
  { id: 'overview', label: 'Site', hint: 'A few km around the lander' },
  { id: 'sun', label: 'Sun', hint: 'Stand behind the lander and look at the Sun' },
  { id: 'earth', label: 'Earth', hint: 'Stand behind the lander and look at Earth' },
]

const LAYER_ROWS: { key: keyof Layers; label: string; hint: string }[] = [
  { key: 'sites', label: 'Sites', hint: 'Landing sites on the Moon' },
  { key: 'psr', label: 'PSRs & ice', hint: 'Permanently shadowed regions and surface-ice detections (Moon Trek)' },
  { key: 'blockers', label: 'Blockers', hint: 'Lines from the lander to the terrain that blocks the Sun (red) or Earth (blue)' },
  {
    key: 'paths',
    label: 'Sun & Earth paths',
    hint: "The Sun's and Earth's paths across the sky over the time window: bright where they clear the terrain, dim where it blocks them",
  },
]

// Material icons (24 dp).
const ICON = {
  site: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z',
  camera: 'M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z',
  topDown: 'M16 13h-3V3h-2v10H8l4 4 4-4zM4 19v2h16v-2H4z', // an arrow straight down onto the ground
  layers: 'M11.99 18.54l-7.37-5.73L3 14.07l9 7 9-7-1.63-1.27-7.38 5.74zM12 16l7.36-5.73L21 9l-9-7-9 7 1.63 1.27L12 16z',
  pin: 'M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z',
  ruler: 'M21 6H3c-1.1 0-2 .9-2 2v8c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 10H3V8h2v4h2V8h2v4h2V8h2v4h2V8h2v4h2V8h2v8z',
  verify: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z',
  play: 'M8 5v14l11-7z',
  pause: 'M6 19h4V5H6v14zm8-14v14h4V5h-4z',
  speed: 'M20.38 8.57l-1.23 1.85a8 8 0 0 1-.22 7.58H5.07A8 8 0 0 1 15.58 6.85l1.85-1.23A10 10 0 0 0 3.35 19a2 2 0 0 0 1.72 1h13.85a2 2 0 0 0 1.74-1 10 10 0 0 0-.27-10.44zm-9.79 6.84a2 2 0 0 0 2.83 0l5.66-8.49-8.49 5.66a2 2 0 0 0 0 2.83z',
  check: 'M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
  flag: 'M14.4 6L14 4H5v17h2v-7h5.6l.4 2h7V6z',
  more: 'M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z',
  hideUi: 'M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z',
  dark: 'M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.389 5.389 0 0 1-4.4 2.26 5.403 5.403 0 0 1-3.14-9.8c-.44-.06-.9-.1-1.36-.1z',
  tour: 'M11 18h2v-2h-2v2zm1-16C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm0-14a4 4 0 0 0-4 4h2a2 2 0 1 1 4 0c0 2-3 1.75-3 5h2c0-2.25 3-2.5 3-5a4 4 0 0 0-4-4z',
}

function Icon({ d, size = 24 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d={d} />
    </svg>
  )
}

/** An icon that is lit (toggled on): its glyph is cut out of the live mango mesh. */
function LitIcon({ d }: { d: string }) {
  const mask = `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='${d}'/></svg>`)}")`
  return (
    <span aria-hidden className="block h-6 w-6" style={{ WebkitMaskImage: mask, maskImage: mask, WebkitMaskSize: '100% 100%', maskSize: '100% 100%' }}>
      <InteractiveGrainGradient className="h-full w-full" />
    </span>
  )
}

function fmtLat(lat: number) {
  return `${Math.abs(lat).toFixed(3)}°${lat < 0 ? 'S' : 'N'}`
}

/** M3 icon button. `selected` = toggled on (filled), `open` = its menu is showing (tonal). */
function ToolButton({
  label,
  tip,
  icon,
  selected,
  open,
  disabled,
  onClick,
  haspopup,
  tourId,
}: {
  label: string
  tip?: string
  icon: string
  selected?: boolean
  open?: boolean
  disabled?: boolean
  onClick: () => void
  haspopup?: boolean
  tourId?: string
}) {
  const tone = selected
    ? 'bg-coral/10 text-coral'
    : open
      ? 'bg-coral/20 text-calcite-ink'
      : 'text-calcite-ink'
  return (
    <button
      type="button"
      data-tour={tourId}
      aria-label={label}
      data-tip={tip ?? label}
      aria-pressed={selected === undefined ? undefined : selected}
      aria-haspopup={haspopup ? 'menu' : undefined}
      aria-expanded={haspopup ? !!open : undefined}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-10 w-10 items-center justify-center rounded-full transition-colors disabled:opacity-40 ${tone}`}
    >
      {selected ? <LitIcon d={icon} /> : <Icon d={icon} />}
    </button>
  )
}

/** A toolbar button with a menu that pops out above it; closes on outside press or Escape. */
function ToolMenu({
  id,
  openId,
  setOpenId,
  label,
  tip,
  icon,
  hover = false,
  onActivate,
  tourId,
  children,
}: {
  id: string
  openId: string | null // the one menu that is open (menus are mutually exclusive)
  setOpenId: (id: string | null) => void
  label: string
  tip: string
  icon: string
  hover?: boolean // the menu opens when hovered or focused; clicking the button runs onActivate instead
  onActivate?: () => void
  tourId?: string
  children: (close: () => void) => ReactNode
}) {
  const open = openId === id
  const [closing, setClosing] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const close = () => setClosing(true)
  const timer = useRef<number>(0)

  // Hover menus: open shortly after the pointer arrives, close shortly after it leaves (the delay lets
  // the pointer cross from the button to the menu).
  const enter = () => {
    if (!hover) return
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      setClosing(false)
      setOpenId(id)
    }, 120)
  }
  const leave = () => {
    if (!hover) return
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      if (open) setClosing(true)
    }, 280)
  }
  useEffect(() => () => window.clearTimeout(timer.current), [])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpenId(null)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpenId(null)
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, setOpenId])

  return (
    <div
      ref={root}
      data-tour={tourId}
      className="relative"
      onPointerEnter={hover ? enter : undefined}
      onPointerLeave={hover ? leave : undefined}
      onFocus={hover ? (e) => e.target.matches(':focus-visible') && enter() : undefined}
      onBlur={hover ? (e) => !root.current?.contains(e.relatedTarget as Node) && leave() : undefined}
    >
      <ToolButton
        label={label}
        tip={open ? undefined : tip}
        icon={icon}
        haspopup
        open={open && !closing}
        onClick={() => {
          if (onActivate) {
            onActivate()
            return
          }
          if (open && !closing) close()
          else {
            setClosing(false)
            setOpenId(id)
          }
        }}
      />
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={label}
          data-toolbar-menu
          className={`absolute bottom-full left-1/2 z-50 min-w-56 pb-3 ${closing ? 'md-menu-out' : 'md-menu'}`}
          onAnimationEnd={() => {
            if (closing) {
              setOpenId(null)
              setClosing(false)
            }
          }}
        >
          <div className="rounded-2xl bg-opal-50 py-2 shadow-xl shadow-black/40">{children(close)}</div>
        </div>
      )}
    </div>
  )
}

/** Shown while "Drop pin" is armed: analyse exact coordinates instead of clicking. */
function CoordinateForm({ onSubmit }: { onSubmit: (lat: number, lon: number) => void }) {
  const [lat, setLat] = useState('')
  const [lon, setLon] = useState('')
  const [error, setError] = useState<string | null>(null)
  return (
    <form
      className="recede-behind-menu md-reveal lp-light pointer-events-auto flex flex-wrap items-center gap-2 rounded-2xl bg-opal-50 px-4 py-2 text-xs text-slate-300 shadow-lg shadow-black/30"
      style={{ ['--md-field-surface' as string]: 'var(--color-opal-50)' }}
      onSubmit={(e) => {
        e.preventDefault()
        const r = parseCoordinates(lat, lon)
        if (typeof r === 'string') setError(r)
        else {
          setError(null)
          onSubmit(...r)
        }
      }}
    >
      <span>Click the terrain, or enter coordinates:</span>
      <TextField
        label="Lat (°)"
        tip="Latitude in degrees; negative is south (the south pole is -90)."
        fieldClassName="w-32"
        inputMode="decimal"
        placeholder="-89.45"
        value={lat}
        onChange={(e) => setLat(e.target.value)}
        aria-label="Latitude (degrees, negative = south)"
      />
      <TextField
        label="Lon (°E)"
        tip="Longitude in degrees east; -180 to 360 is accepted."
        fieldClassName="w-32"
        inputMode="decimal"
        placeholder="222.69"
        value={lon}
        onChange={(e) => setLon(e.target.value)}
        aria-label="Longitude (degrees east)"
      />
      <button type="submit" className="md-compact border border-opal-300 bg-panel-fill transition-colors hover:bg-calcite-peach/40">
        Analyse
      </button>
      {error && <span role="alert" className="w-full text-red-300">{error}</span>}
    </form>
  )
}

export function MapTools({
  layers,
  onLayers,
  pin,
  onArmPin,
  onCoordinates,
  siteId,
  sites,
  sitesError,
  sitesLoading,
  timeUtc,
  view,
  onView,
  onGoToView,
  graphics,
  onGraphics,
  farShadows,
  farShadowsAvailable,
  onFarShadows,
  mission,
  measure,
}: {
  layers: Layers
  onLayers: (l: Layers) => void
  pin: PinState
  onArmPin: (armed: boolean) => void
  onCoordinates: (lat: number, lon: number) => void
  siteId: string | null
  sites: SiteInfo[] | null // every landing site, for the Select site menu
  sitesError: string | null
  sitesLoading: boolean
  timeUtc: string
  view: ViewMode
  onView: (v: ViewMode) => void
  onGoToView: () => void // fly the camera to the chosen view (again, if you have orbited away)
  graphics: GraphicsQuality
  onGraphics: (q: GraphicsQuality) => void
  farShadows: boolean
  farShadowsAvailable: boolean // not in the Low preset (no shadows at all there)
  onFarShadows: (on: boolean) => void
  mission: { available: boolean; active: boolean; reason: string; start: () => void; stop: () => void } // mission playback
  measure: MeasureController
}) {
  const [verify, setVerify] = useState<{ loading: boolean; result: VerifyResult | null; error: string | null } | null>(null)
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const dark = useUiPrefs((u) => u.dark)
  const setDark = useUiPrefs((u) => u.setDark)
  const hideUi = useUiPrefs((u) => u.hideUi)
  const topDown = useCameraTilt((s) => s.topDown)
  const playing = useAppStore((s) => s.playing)
  const setPlaying = useAppStore((s) => s.setPlaying)

  const runVerify = () => {
    if (!siteId) return
    useTutorialStore.getState().recordInteraction('jpl-verify')
    setVerify({ loading: true, result: null, error: null })
    fetchVerify(siteId, timeUtc)
      .then((result) => {
        setVerify({ loading: false, result, error: null })
        showSnackbar('JPL Horizons check complete', 'success')
      })
      .catch((e: unknown) => {
        const message = e instanceof Error ? e.message : String(e)
        setVerify({ loading: false, result: null, error: message })
        showSnackbar(`JPL check failed: ${message}`, 'error')
      })
  }
  const toggle = (k: keyof Layers) => {
    onLayers({ ...layers, [k]: !layers[k] })
    useTutorialStore.getState().recordInteraction('layer-toggle')
    const name = LAYER_ROWS.find((r) => r.key === k)?.label ?? k
    showSnackbar(`${name} ${layers[k] ? 'hidden' : 'shown'}`)
  }
  const armed = pin.phase === 'armed'
  const measureOpen = measure.armed || measure.waypoints.length > 0

  return (
    // Column-reverse: the toolbar is the bottom item; messages and the verify panel open upwards.
    <div className="lp-light pointer-events-none mb-2 flex flex-col-reverse items-center gap-2">
      {/* Wraps onto a second row on phones instead of pushing Play and More off-screen. No overflow scrolling: the
          tool menus open above their buttons and a scroll container would clip them. 28 px = fully round at one row. */}
      <div role="toolbar" aria-label="Map tools" className="pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-1 rounded-[28px] bg-opal-50 p-2 shadow-lg shadow-black/30">
        <ToolButton
          tourId="play-time"
          label={playing ? 'Pause' : 'Play'}
          tip={playing ? 'Pause: stop the time simulation' : 'Play: run the simulation forward in time at the chosen speed'}
          icon={playing ? ICON.pause : ICON.play}
          selected={playing}
          disabled={!siteId}
          onClick={() => {
            useTutorialStore.getState().recordInteraction('time-play')
            setPlaying(!playing)
          }}
        />
        <ToolButton
          tourId="play-mission"
          label={mission.active ? 'Stop the mission playback' : mission.available ? `Play mission: ${mission.reason.replace(/^Play the plan: /, '')}` : `Play mission: ${mission.reason}`}
          icon={ICON.flag}
          selected={mission.active}
          disabled={!mission.active && !mission.available}
          onClick={() => {
            useTutorialStore.getState().recordInteraction('plan-play')
            if (mission.active) mission.stop()
            else mission.start()
          }}
        />
        <span className="mx-1 h-6 w-px bg-opal-300" aria-hidden />
        <ToolMenu tourId="site-select" openId={openMenu} setOpenId={setOpenMenu} id="site" label="Select site"
          tip="Select site: choose the landing site shown in the 3D view and used for the timeline" icon={ICON.site}>
          {(close) => <SiteMenuRows sites={sites} error={sitesError} loading={sitesLoading} onPicked={close} />}
        </ToolMenu>
        <ToolMenu tourId="camera-menu" openId={openMenu} setOpenId={setOpenMenu} id="camera" hover={!armed && !measureOpen} onActivate={() => {
            onGoToView()
            useTutorialStore.getState().recordInteraction('camera-view')
            showSnackbar(`Camera: ${VIEWS.find((v) => v.id === view)?.label ?? view}`)
          }} label="Camera position" tip="Camera: click to fly to the chosen view. Hover to pick a different one (whole Moon, region, site, or a lander's-eye view of the Sun or Earth)." icon={ICON.camera}>
          {(close) =>
            VIEWS.map((v) => (
              <button
                key={v.id}
                type="button"
                role="menuitemradio"
                aria-checked={view === v.id}
                data-tip={v.hint}
                onClick={() => {
                  showSnackbar(`Camera: ${v.label}`)
                  useTutorialStore.getState().recordInteraction('camera-view')
                  onView(v.id)
                  onGoToView()
                  close()
                }}
                className={`flex h-12 w-full items-center gap-3 px-4 text-left text-sm transition-colors ${view === v.id ? 'bg-coral/15 font-semibold' : ''}`}
              >
                <span className="flex h-6 w-6 items-center justify-center text-coral">{view === v.id && <Icon d={ICON.check} size={20} />}</span>
                {v.label}
              </button>
            ))
          }
        </ToolMenu>
        <ToolButton
          tourId="top-down"
          label={topDown ? 'Top-down view: on (click to tilt back)' : 'Top-down view: look straight down'}
          tip={
            topDown
              ? 'Top-down view is on. Click (or press U) to tilt back to the angle you had. Right-drag or Shift + drag tilts freely.'
              : 'Top-down view: look straight down at the middle of the view (or press U). Click again to tilt back. Right-drag or Shift + drag tilts freely.'
          }
          icon={ICON.topDown}
          selected={topDown}
          onClick={() => {
            toggleTopDown()
            useTutorialStore.getState().recordInteraction('top-down')
            showSnackbar(topDown ? 'Camera: tilted' : 'Camera: top-down')
          }}
        />
        <ToolMenu tourId="map-layers" openId={openMenu} setOpenId={setOpenMenu} id="layers" label="Map layers" tip="Map layers: switch on landing sites, permanently shadowed regions and ice, and lines to the terrain blocking the Sun or Earth" icon={ICON.layers}>
          {() =>
            LAYER_ROWS.map((r) => (
              <button
                key={r.key}
                type="button"
                role="switch"
                aria-checked={layers[r.key]}
                data-tip={r.hint}
                data-no-ripple
                onClick={() => toggle(r.key)}
                className="md-row flex h-14 w-full items-center justify-between gap-6 px-4 text-left text-sm"
              >
                {r.label}
                <span className="md-switch" aria-hidden>
                  <span className="md-switch-handle">
                    <Icon d={ICON.check} size={16} />
                  </span>
                </span>
              </button>
            ))
          }
        </ToolMenu>
        <ToolButton
          tourId="drop-pin"
          label={armed ? 'Click the terrain to drop a pin (click again to cancel)' : 'Drop pin: click anywhere on the terrain to analyse that spot'}
          icon={ICON.pin}
          selected={armed}
          disabled={pin.phase === 'working'}
          onClick={() => {
            useTutorialStore.getState().recordInteraction('drop-pin')
            onArmPin(!armed)
          }}
        />
        <ToolButton
          tourId="measure-tool"
          label={
            measure.armed
              ? 'Measure tool active: click points on the terrain (click again to stop adding points)'
              : 'Measure distance & traverse: place waypoints on the Moon to measure surface distance, slope hazards, and line-of-sight'
          }
          icon={ICON.ruler}
          selected={measure.armed}
          disabled={!siteId}
          onClick={() => {
            useTutorialStore.getState().recordInteraction('measure-arm')
            measure.onArm(!measure.armed)
          }}
        />
        <ToolButton
          tourId="jpl-verify"
          label={verify?.loading ? 'Asking JPL…' : "Verify with JPL: compare this hour's Sun/Earth positions with JPL Horizons, live"}
          icon={ICON.verify}
          selected={verify?.loading ? true : undefined}
          disabled={!siteId || verify?.loading}
          onClick={runVerify}
        />
        <span className="mx-1 h-6 w-px bg-opal-300" aria-hidden />
        <ToolMenu tourId="more-menu" openId={openMenu} setOpenId={setOpenMenu} id="more" label="More" tip="More: graphics quality, dark mode, guided tour, and hide the whole interface" icon={ICON.more}>
          {(close) => (
            <>
              <p className="px-4 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Graphics quality</p>
              {(Object.keys(GRAPHICS) as GraphicsQuality[]).map((q) => (
                <button
                  key={q}
                  type="button"
                  role="menuitemradio"
                  aria-checked={graphics === q}
                  data-tip={GRAPHICS[q].hint}
                  onClick={() => {
                    if (q !== graphics) showSnackbar(`Graphics set to ${GRAPHICS[q].label}`, 'success')
                    onGraphics(q)
                    close()
                  }}
                  className={`flex h-12 w-full items-center gap-3 px-4 text-left text-sm transition-colors ${graphics === q ? 'bg-coral/15 font-semibold' : ''}`}
                >
                  <span className="flex h-6 w-6 items-center justify-center text-coral">{graphics === q && <Icon d={ICON.check} size={20} />}</span>
                  {GRAPHICS[q].label}
                  {q === 'high' ? ' (default)' : ' (Chromebook)'}
                </button>
              ))}
              <div className="my-1 h-px bg-opal-300" aria-hidden />
              <button
                key="far-shadows"
                type="button"
                role="switch"
                aria-checked={farShadows}
                disabled={!farShadowsAvailable}
                data-tip={
                  farShadowsAvailable
                    ? 'Shadows from all terrain on screen, not just ~6 km around the lander (cascaded shadow maps; more GPU work while the camera moves)'
                    : 'Not available in the Low graphics setting (no shadows)'
                }
                data-no-ripple
                onClick={() => {
                  onFarShadows(!farShadows)
                  showSnackbar(`Far shadows ${farShadows ? 'off' : 'on'}`)
                }}
                className="md-row flex h-14 w-full items-center justify-between gap-6 px-4 text-left text-sm disabled:opacity-40"
              >
                Far shadows
                <span className="md-switch" aria-hidden>
                  <span className="md-switch-handle">
                    <Icon d={ICON.check} size={16} />
                  </span>
                </span>
              </button>
              <div className="my-1 h-px bg-opal-300" aria-hidden />
              <button
                type="button"
                role="switch"
                aria-checked={dark}
                data-tip="Dark mode: dark panels instead of light ones"
                data-no-ripple
                onClick={() => {
                  setDark(!dark)
                  showSnackbar(`Dark mode ${dark ? 'off' : 'on'}`)
                }}
                className="md-row flex h-14 w-full items-center justify-between gap-6 px-4 text-left text-sm"
              >
                Dark mode
                <span className="md-switch" aria-hidden>
                  <span className="md-switch-handle">
                    <Icon d={ICON.check} size={16} />
                  </span>
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                data-tour="menu-tour"
                data-tip="Guided Tour: one real mission across all four views"
                onClick={() => {
                  close()
                  useTutorialStore.getState().startTour(0)
                }}
                className="flex h-12 w-full items-center gap-3 px-4 text-left text-sm"
              >
                <span className="flex h-6 w-6 items-center justify-center text-coral"><Icon d={ICON.tour} size={20} /></span>
                Guided Tour
                <span className="ml-auto text-xs text-slate-400">3 acts</span>
              </button>
              <button
                type="button"
                role="menuitem"
                data-tip="Hide all UI: everything fades away so only the Moon is left. Press Esc to bring it back."
                onClick={() => {
                  close()
                  hideUi()
                }}
                className="flex h-12 w-full items-center gap-3 px-4 text-left text-sm"
              >
                <span className="flex h-6 w-6 items-center justify-center"><Icon d={ICON.hideUi} size={20} /></span>
                Hide all UI
                <span className="ml-auto text-xs text-slate-400">Esc to show</span>
              </button>
            </>
          )}
        </ToolMenu>
      </div>

      {armed && <CoordinateForm onSubmit={onCoordinates} />}
      {measureOpen && (
        <MeasureCard
          armed={measure.armed}
          waypoints={measure.waypoints}
          selectedWaypointId={measure.selectedWaypointId}
          onSelectWaypoint={measure.onSelectWaypoint}
          hoveredWaypointId={measure.hoveredWaypointId}
          onHoverWaypoint={measure.onHoverWaypoint}
          onRenameWaypoint={measure.onRenameWaypoint}
          onDeleteWaypoint={measure.onDeleteWaypoint}
          analysis={measure.analysis}
          hoveredSample={measure.hoveredSample}
          onHoverSample={measure.onHoverSample}
          onStartAtLander={measure.onStartAtLander}
          onUndo={measure.onUndo}
          onClear={measure.onClear}
          onClose={measure.onClose}
          onAnalyseEndpoint={(lat, lon) => {
            measure.onArm(false)
            onCoordinates(lat, lon)
          }}
          finestResM={measure.finestResM}
          drawer={measure.drawer}
          onDrawerChange={measure.onDrawerChange}
        />
      )}
      {pin.phase === 'working' && (
        <p className="recede-behind-menu md-reveal pointer-events-auto rounded bg-slate-950/85 px-2 py-1 text-xs text-slate-200">
          Analysing {fmtLat(pin.lat)}, {pin.lon.toFixed(3)}°E… downloading terrain can take up to a minute in a new area.
        </p>
      )}

      {verify && !verify.loading && (
        <JplHorizonsCard
          result={verify.result}
          error={verify.error}
          onClose={() => setVerify(null)}
        />
      )}
    </div>
  )
}

/** Colour key for the map layers that are switched on (small white text, top-left of the view). */
export function ColorKey({ layers }: { layers: Layers }) {
  if (!layers.sites && !layers.psr && !layers.blockers) return null
  const dot = (c: string) => <span className="inline-block h-2 w-2 rounded-full" style={{ background: c }} />
  return (
    <div className="md-reveal pointer-events-none mt-4 max-w-[30rem] text-[10px] leading-snug text-white" style={{ textShadow: '0 1px 4px rgba(0,0,0,0.9)' }} aria-label="Colour key">
      {layers.sites && (
        <p className="flex flex-wrap gap-x-3">
          {(
            [
              [KIND_COLOR.artemis, "Artemis III (NASA's 2024 list)"],
              [ARTEMIS_FORMER_COLOR, 'Earlier Artemis candidates (2022)'],
              [KIND_COLOR.apollo, 'Apollo'],
              [KIND_COLOR.clps, 'Commercial (CLPS)'],
              [KIND_COLOR.international, 'Other countries'],
              [KIND_COLOR.custom, 'Your pins'],
            ] as const
          ).map(([colour, label]) => (
            <span key={label} className="flex items-center gap-1">
              {dot(colour)}
              {label}
            </span>
          ))}
        </p>
      )}
      {layers.psr && (
        <p className="flex flex-wrap gap-x-3">
          <span className="flex items-center gap-1">{dot('#7dd3fc')} PSR (approx. extent)</span>
          <span className="flex items-center gap-1">{dot('#e0f2fe')} Surface ice</span>
        </p>
      )}
      {layers.blockers && (
        <p className="flex flex-wrap gap-x-3">
          <span className="flex items-center gap-1">{dot('#ef4444')} Terrain blocking the Sun</span>
          <span className="flex items-center gap-1">{dot('#60a5fa')} Terrain blocking Earth</span>
        </p>
      )}
    </div>
  )
}
