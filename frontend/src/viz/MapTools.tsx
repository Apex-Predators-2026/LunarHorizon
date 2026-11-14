// Toolbar over the 3D view: drop a pin anywhere on the Moon, toggle the surface layers, and
// check the current hour against JPL Horizons live.
import { useState } from 'react'
import type { VerifyResult } from '../types'
import { fetchVerify } from './api'
import { KIND_COLOR } from './globe/overlays'
import { GRAPHICS, type GraphicsQuality } from './graphics'

export interface Layers {
  sites: boolean
  psr: boolean
  blockers: boolean
}

export type PinState =
  | { phase: 'idle' }
  | { phase: 'armed' }
  | { phase: 'working'; lat: number; lon: number }
  | { phase: 'error'; message: string }

const btn = 'rounded border px-2 py-1 text-xs'
const on = 'border-sky-500 bg-sky-500/20 text-sky-200'
const off = 'border-opal-300 bg-white text-slate-300 hover:bg-calcite-peach/40'

function fmtLat(lat: number) {
  return `${Math.abs(lat).toFixed(3)}°${lat < 0 ? 'S' : 'N'}`
}

export function MapTools({
  layers,
  onLayers,
  pin,
  onArmPin,
  siteId,
  timeUtc,
  graphics,
  onGraphics,
}: {
  layers: Layers
  onLayers: (l: Layers) => void
  pin: PinState
  onArmPin: (armed: boolean) => void
  siteId: string | null
  timeUtc: string
  graphics: GraphicsQuality
  onGraphics: (q: GraphicsQuality) => void
}) {
  const [verify, setVerify] = useState<{ loading: boolean; result: VerifyResult | null; error: string | null } | null>(null)

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
    // Bottom centre, just above the time bar (the top corners hold the HUD and the sky plot);
    // column-reverse so messages and the verify panel open upwards.
    <div className="lp-light pointer-events-none mb-2 flex flex-col-reverse items-center gap-1.5">
      <div className="pointer-events-auto flex flex-wrap items-center gap-1 rounded-xl bg-opal-50 p-1.5 shadow-lg shadow-black/30">
        <button
          type="button"
          className={`${btn} ${armed ? 'border-calcite-orange bg-calcite-orange/20 text-slate-100' : off}`}
          aria-pressed={armed}
          disabled={pin.phase === 'working'}
          onClick={() => onArmPin(!armed)}
          title="Click anywhere on the terrain to analyse that spot"
        >
          {armed ? 'Click the terrain…' : 'Drop pin'}
        </button>
        <span className="mx-0.5 h-4 w-px bg-slate-700" aria-hidden="true" />
        <button type="button" className={`${btn} ${layers.sites ? on : off}`} aria-pressed={layers.sites} onClick={() => toggle('sites')}>
          Sites
        </button>
        <button type="button" className={`${btn} ${layers.psr ? on : off}`} aria-pressed={layers.psr} onClick={() => toggle('psr')}
          title="Permanently shadowed regions and surface-ice detections (Moon Trek)">
          PSRs & ice
        </button>
        <button type="button" className={`${btn} ${layers.blockers ? on : off}`} aria-pressed={layers.blockers} onClick={() => toggle('blockers')}
          title="Lines from the lander to the terrain that blocks the Sun (red) or Earth (blue)">
          Blockers
        </button>
        <span className="mx-0.5 h-4 w-px bg-slate-700" aria-hidden="true" />
        <button type="button" className={`${btn} ${off}`} onClick={runVerify} disabled={!siteId || verify?.loading}
          title="Compare this hour's Sun/Earth positions with JPL Horizons, live">
          {verify?.loading ? 'Asking JPL…' : 'Verify with JPL'}
        </button>
        <span className="mx-0.5 h-4 w-px bg-slate-700" aria-hidden="true" />
        <label className="flex items-center gap-1 text-xs text-slate-300" title={GRAPHICS[graphics].hint}>
          Graphics
          <select
            className="rounded border border-opal-300 bg-white px-1 py-1 text-xs text-slate-300"
            value={graphics}
            onChange={(e) => onGraphics(e.target.value as GraphicsQuality)}
          >
            {(Object.keys(GRAPHICS) as GraphicsQuality[]).map((q) => (
              <option key={q} value={q} title={GRAPHICS[q].hint}>
                {GRAPHICS[q].label}
                {q === 'high' ? ' (default)' : ' (Chromebook)'}
              </option>
            ))}
          </select>
        </label>
      </div>

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
