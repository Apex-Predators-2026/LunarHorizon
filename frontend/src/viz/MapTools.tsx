// Floating toolbar over the 3D view (M3 "floating toolbar"): camera menu, layers menu (switches),
// drop pin (click the terrain or type coordinates), verify with JPL, and play / pause. Messages, the legend and the JPL result open above it.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useAppStore } from '../store'
import type { VerifyResult } from '../types'
import { fetchVerify } from './api'
import type { ViewMode } from './CameraRig'
import { KIND_COLOR } from './globe/overlays'
import { parseCoordinates } from './coordinates'
import { GRAPHICS, type GraphicsQuality } from './graphics'

export interface Layers {
  sites: boolean
  psr: boolean
  blockers: boolean
  imagery: boolean // LRO WAC photo mosaic on the terrain (off by default: its shadows are not "now")
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
    key: 'imagery',
    label: 'LRO imagery',
    hint: 'LRO Wide Angle Camera photo mosaic (Moon Trek, ~100 m/px) on the terrain. Its shadows are from when the photos were taken, not from the time shown.',
  },
]

// Material icons (24 dp).
const ICON = {
  camera: 'M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z',
  layers: 'M11.99 18.54l-7.37-5.73L3 14.07l9 7 9-7-1.63-1.27-7.38 5.74zM12 16l7.36-5.73L21 9l-9-7-9 7 1.63 1.27L12 16z',
  pin: 'M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z',
  verify: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z',
  play: 'M8 5v14l11-7z',
  pause: 'M6 19h4V5H6v14zm8-14v14h4V5h-4z',
  speed: 'M20.38 8.57l-1.23 1.85a8 8 0 0 1-.22 7.58H5.07A8 8 0 0 1 15.58 6.85l1.85-1.23A10 10 0 0 0 3.35 19a2 2 0 0 0 1.72 1h13.85a2 2 0 0 0 1.74-1 10 10 0 0 0-.27-10.44zm-9.79 6.84a2 2 0 0 0 2.83 0l5.66-8.49-8.49 5.66a2 2 0 0 0 0 2.83z',
  check: 'M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
}

function Icon({ d, size = 24 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d={d} />
    </svg>
  )
}

function fmtLat(lat: number) {
  return `${Math.abs(lat).toFixed(3)}°${lat < 0 ? 'S' : 'N'}`
}

/** M3 icon button. `selected` = toggled on (filled), `open` = its menu is showing (tonal). */
function ToolButton({
  label,
  icon,
  selected,
  open,
  disabled,
  onClick,
  haspopup,
}: {
  label: string
  icon: string
  selected?: boolean
  open?: boolean
  disabled?: boolean
  onClick: () => void
  haspopup?: boolean
}) {
  const tone = selected
    ? 'bg-coral text-white'
    : open
      ? 'bg-coral/20 text-calcite-ink'
      : 'text-calcite-ink'
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={selected === undefined ? undefined : selected}
      aria-haspopup={haspopup ? 'menu' : undefined}
      aria-expanded={haspopup ? !!open : undefined}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-10 w-10 items-center justify-center rounded-full transition-colors disabled:opacity-40 ${tone}`}
    >
      <Icon d={icon} />
    </button>
  )
}

/** A toolbar button with a menu that pops out above it; closes on outside press or Escape. */
function ToolMenu({
  label,
  icon,
  children,
}: {
  label: string
  icon: string
  children: (close: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [closing, setClosing] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const close = () => setClosing(true)

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setClosing(true)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setClosing(true)
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={root} className="relative">
      <ToolButton
        label={label}
        icon={icon}
        haspopup
        open={open && !closing}
        onClick={() => (open && !closing ? close() : (setOpen(true), setClosing(false)))}
      />
      {open && (
        <div
          role="menu"
          aria-label={label}
          className={`absolute bottom-full left-1/2 mb-3 min-w-56 rounded-2xl bg-opal-50 py-2 shadow-xl shadow-black/40 ${closing ? 'md-menu-out' : 'md-menu'}`}
          onAnimationEnd={() => {
            if (closing) {
              setOpen(false)
              setClosing(false)
            }
          }}
        >
          {children(close)}
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
  const field = 'w-24 rounded-lg border border-opal-300 bg-white px-1.5 py-0.5 text-xs text-slate-300'
  return (
    <form
      className="md-reveal lp-light pointer-events-auto flex flex-wrap items-center gap-1.5 rounded-xl bg-opal-50 px-2 py-1.5 text-xs text-slate-300 shadow-lg shadow-black/30"
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
      <label className="flex items-center gap-1">
        Lat
        <input className={field} inputMode="decimal" placeholder="-89.45" value={lat} onChange={(e) => setLat(e.target.value)} aria-label="Latitude (degrees, negative = south)" />
      </label>
      <label className="flex items-center gap-1">
        Lon
        <input className={field} inputMode="decimal" placeholder="222.69" value={lon} onChange={(e) => setLon(e.target.value)} aria-label="Longitude (degrees east)" />
      </label>
      <button type="submit" className="rounded-lg border border-opal-300 bg-white px-2 py-0.5 transition-colors hover:bg-calcite-peach/40">
        Analyse
      </button>
      {error && <span className="w-full text-red-300">{error}</span>}
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
  timeUtc,
  view,
  onView,
  graphics,
  onGraphics,
  farShadows,
  farShadowsAvailable,
  onFarShadows,
}: {
  layers: Layers
  onLayers: (l: Layers) => void
  pin: PinState
  onArmPin: (armed: boolean) => void
  onCoordinates: (lat: number, lon: number) => void
  siteId: string | null
  timeUtc: string
  view: ViewMode
  onView: (v: ViewMode) => void
  graphics: GraphicsQuality
  onGraphics: (q: GraphicsQuality) => void
  farShadows: boolean
  farShadowsAvailable: boolean // not in the Low preset (no shadows at all there)
  onFarShadows: (on: boolean) => void
}) {
  const [verify, setVerify] = useState<{ loading: boolean; result: VerifyResult | null; error: string | null } | null>(null)
  const playing = useAppStore((s) => s.playing)
  const setPlaying = useAppStore((s) => s.setPlaying)

  const runVerify = () => {
    if (!siteId) return
    setVerify({ loading: true, result: null, error: null })
    fetchVerify(siteId, timeUtc)
      .then((result) => setVerify({ loading: false, result, error: null }))
      .catch((e: unknown) => setVerify({ loading: false, result: null, error: e instanceof Error ? e.message : String(e) }))
  }
  const toggle = (k: keyof Layers) => onLayers({ ...layers, [k]: !layers[k] })
  const armed = pin.phase === 'armed'

  return (
    // Column-reverse: the toolbar is the bottom item; messages and the verify panel open upwards.
    <div className="lp-light pointer-events-none mb-2 flex flex-col-reverse items-center gap-1.5">
      <div role="toolbar" aria-label="Map tools" className="pointer-events-auto flex items-center gap-1 rounded-full bg-opal-50 p-1.5 shadow-lg shadow-black/30">
        <ToolButton
          label={playing ? 'Pause' : 'Play'}
          icon={playing ? ICON.pause : ICON.play}
          selected={playing}
          disabled={!siteId}
          onClick={() => setPlaying(!playing)}
        />
        <span className="mx-0.5 h-6 w-px bg-opal-300" aria-hidden />
        <ToolMenu label="Camera position" icon={ICON.camera}>
          {(close) =>
            VIEWS.map((v) => (
              <button
                key={v.id}
                type="button"
                role="menuitemradio"
                aria-checked={view === v.id}
                title={v.hint}
                onClick={() => {
                  onView(v.id)
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
        <ToolMenu label="Map layers" icon={ICON.layers}>
          {() =>
            LAYER_ROWS.map((r) => (
              <button
                key={r.key}
                type="button"
                role="switch"
                aria-checked={layers[r.key]}
                title={r.hint}
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
          label={armed ? 'Click the terrain to drop a pin (click again to cancel)' : 'Drop pin: click anywhere on the terrain to analyse that spot'}
          icon={ICON.pin}
          selected={armed}
          disabled={pin.phase === 'working'}
          onClick={() => onArmPin(!armed)}
        />
        <ToolButton
          label={verify?.loading ? 'Asking JPL…' : "Verify with JPL: compare this hour's Sun/Earth positions with JPL Horizons, live"}
          icon={ICON.verify}
          selected={verify?.loading ? true : undefined}
          disabled={!siteId || verify?.loading}
          onClick={runVerify}
        />
        <span className="mx-0.5 h-6 w-px bg-opal-300" aria-hidden />
        <ToolMenu label="Graphics quality" icon={ICON.speed}>
          {(close) =>
            (Object.keys(GRAPHICS) as GraphicsQuality[]).map((q) => (
              <button
                key={q}
                type="button"
                role="menuitemradio"
                aria-checked={graphics === q}
                title={GRAPHICS[q].hint}
                onClick={() => {
                  onGraphics(q)
                  close()
                }}
                className={`flex h-12 w-full items-center gap-3 px-4 text-left text-sm transition-colors ${graphics === q ? 'bg-coral/15 font-semibold' : ''}`}
              >
                <span className="flex h-6 w-6 items-center justify-center text-coral">{graphics === q && <Icon d={ICON.check} size={20} />}</span>
                {GRAPHICS[q].label}
                {q === 'high' ? ' (default)' : ' (Chromebook)'}
              </button>
            )).concat(
              <div key="divider" className="my-1 h-px bg-opal-300" aria-hidden />,
              <button
                key="far-shadows"
                type="button"
                role="switch"
                aria-checked={farShadows}
                disabled={!farShadowsAvailable}
                title={
                  farShadowsAvailable
                    ? 'Shadows from all terrain on screen, not just ~6 km around the lander (cascaded shadow maps; more GPU work while the camera moves)'
                    : 'Not available in the Low graphics setting (no shadows)'
                }
                data-no-ripple
                onClick={() => onFarShadows(!farShadows)}
                className="md-row flex h-14 w-full items-center justify-between gap-6 px-4 text-left text-sm disabled:opacity-40"
              >
                Far shadows
                <span className="md-switch" aria-hidden>
                  <span className="md-switch-handle">
                    <Icon d={ICON.check} size={16} />
                  </span>
                </span>
              </button>,
            )
          }
        </ToolMenu>
      </div>

      {armed && <CoordinateForm onSubmit={onCoordinates} />}
      {pin.phase === 'working' && (
        <p className="md-reveal pointer-events-auto rounded bg-slate-950/85 px-2 py-1 text-xs text-slate-200">
          Analysing {fmtLat(pin.lat)}, {pin.lon.toFixed(3)}°E… downloading terrain can take up to a minute in a new area.
        </p>
      )}
      {pin.phase === 'error' && (
        <p className="md-reveal pointer-events-auto rounded bg-red-950/85 px-2 py-1 text-xs text-red-200">Couldn't analyse that spot: {pin.message}</p>
      )}

      {layers.sites && (
        <p className="md-reveal pointer-events-auto flex flex-wrap gap-x-2 rounded bg-slate-950/70 px-2 py-0.5 text-[10px] text-slate-300">
          {(['artemis', 'apollo', 'clps', 'international', 'custom'] as const).map((k) => (
            <span key={k} className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: KIND_COLOR[k] }} />
              {{ artemis: 'Artemis candidates', apollo: 'Apollo', clps: 'Commercial (CLPS)', international: 'Other countries', custom: 'Your pins' }[k]}
            </span>
          ))}
          {layers.psr && <span className="text-sky-300">○ PSR (approx. extent) · · surface ice</span>}
        </p>
      )}

      {verify && !verify.loading && (
        <div className="md-reveal pointer-events-auto w-[30rem] max-w-full rounded-xl border border-opal-300 bg-opal-50 p-2 text-xs text-slate-200">
          <div className="mb-1 flex items-center justify-between">
            <span className="font-medium">Live check against JPL Horizons</span>
            <button type="button" className="text-slate-400 hover:text-slate-100" onClick={() => setVerify(null)} aria-label="Close">
              ✕
            </button>
          </div>
          {verify.error && <p className="text-red-300">{verify.error}</p>}
          {verify.result && (
            <>
              <table className="w-full tabular-nums">
                <thead className="text-slate-400">
                  <tr>
                    <th className="text-left font-normal">{verify.result.time_utc.replace('T', ' ')}</th>
                    <th className="text-right font-normal">Ours (az / el)</th>
                    <th className="text-right font-normal">JPL Horizons</th>
                    <th className="text-right font-normal">Difference</th>
                  </tr>
                </thead>
                <tbody>
                  {(['sun', 'earth'] as const).map((b) => {
                    const r = verify.result!.bodies[b]
                    return (
                      <tr key={b}>
                        <td className="capitalize">{b}</td>
                        <td className="text-right">{r.stored.azimuth_deg.toFixed(3)}° / {r.stored.elevation_deg.toFixed(3)}°</td>
                        <td className="text-right">{r.horizons.azimuth_deg.toFixed(3)}° / {r.horizons.elevation_deg.toFixed(3)}°</td>
                        <td className={`text-right ${r.stored_vs_horizons_deg < 0.001 ? 'text-emerald-300' : 'text-amber-300'}`}>
                          {r.stored_vs_horizons_deg.toFixed(4)}°
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              <p className="mt-1 text-[10px] text-slate-400">
                {verify.result.note} Independent check (Skyfield + DE421) vs JPL: Sun{' '}
                {verify.result.bodies.sun.skyfield_vs_horizons_deg.toFixed(5)}°, Earth{' '}
                {verify.result.bodies.earth.skyfield_vs_horizons_deg.toFixed(5)}°.{' '}
                <a className="text-sky-300 underline" href={verify.result.horizons_example_query} target="_blank" rel="noreferrer">
                  Open the Horizons query
                </a>
              </p>
            </>
          )}
        </div>
      )}
    </div>
  )
}
