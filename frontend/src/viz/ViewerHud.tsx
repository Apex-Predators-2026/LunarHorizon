import { useEffect } from 'react'
import { useAppStore } from '../store'
import type { SiteInfo, SiteStatus } from '../types'
import type { ViewMode } from './CameraRig'

const toInput = (iso: string) => iso.slice(0, 16) // "2027-01-01T00:00"
const fromInput = (v: string) => `${v}:00Z`
const fmt = (iso: string | null) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : 'not before 2029')

function hoursUntil(fromIso: string, toIso: string | null) {
  if (!toIso) return ''
  const h = (Date.parse(toIso) - Date.parse(fromIso)) / 3.6e6
  return h < 48 ? ` (in ${Math.round(h)} h)` : ` (in ${(h / 24).toFixed(1)} d)`
}

/**
 * Minimal overlay for the 3D view: pick a site and time, read the conditions.
 * Phase 5 adds the time slider/playback; the main mission panel is Nimansh's.
 */
const VIEWS: { id: ViewMode; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'sun', label: 'Look at Sun' },
  { id: 'earth', label: 'Look at Earth' },
]

export function ViewerHud({
  sites,
  status,
  error,
  loading,
  view,
  onView,
}: {
  sites: SiteInfo[] | null
  status: SiteStatus | null
  error: string | null
  loading: boolean
  view: ViewMode
  onView: (v: ViewMode) => void
}) {
  const { siteId, timeUtc, setSite, setTime } = useAppStore()
  const site = sites?.find((s) => s.id === siteId) ?? null

  // Pick a default site, and keep the time inside the site's data range.
  useEffect(() => {
    if (sites?.length && !site) setSite((sites.find((s) => s.id === 'connecting-ridge') ?? sites[0]).id)
  }, [sites, site, setSite])
  useEffect(() => {
    if (site && (timeUtc < site.data_start_utc || timeUtc > site.data_stop_utc)) setTime(site.data_start_utc)
  }, [site, timeUtc, setTime])

  const box = 'rounded-md border border-slate-700 bg-slate-950/80 p-3 text-xs text-slate-200 backdrop-blur'
  const input = 'w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-slate-100'

  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col gap-2 p-3">
      <div className={`${box} pointer-events-auto w-72 space-y-2`}>
        <label className="block">
          <span className="text-slate-400">Site</span>
          <select className={input} value={siteId ?? ''} onChange={(e) => setSite(e.target.value)}>
            {sites?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-slate-400">Time (UTC)</span>
          <input
            type="datetime-local"
            className={input}
            value={toInput(timeUtc)}
            min={site ? toInput(site.data_start_utc) : undefined}
            max={site ? toInput(site.data_stop_utc) : undefined}
            onChange={(e) => e.target.value && setTime(fromInput(e.target.value))}
          />
        </label>

        <div className="flex gap-1" role="group" aria-label="Camera view">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => onView(v.id)}
              aria-pressed={view === v.id}
              className={`flex-1 rounded border px-1.5 py-1 ${
                view === v.id ? 'border-sky-500 bg-sky-500/20 text-sky-200' : 'border-slate-700 hover:bg-slate-800'
              }`}
            >
              {v.label}
            </button>
          ))}
        </div>

        {error && <p className="text-red-400">{error}. Is the backend running on port 8000?</p>}
        {!error && loading && <p className="text-slate-400">Loading…</p>}

        {status && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            <dt className="text-slate-400">Sunlight</dt>
            <dd>
              {Math.round(status.sun.visible_fraction * 100)}% of disk · el {status.sun.elevation_deg.toFixed(2)}° vs
              terrain {status.sun.horizon_deg.toFixed(2)}°
            </dd>
            <dt className="text-slate-400">Earth</dt>
            <dd>
              {status.earth.visible ? 'in view' : 'blocked'} · margin {status.earth.margin_deg.toFixed(2)}°
            </dd>
            <dt className="text-slate-400">{status.sun.visible_fraction > 0 ? 'Next sunset' : 'Next sunrise'}</dt>
            <dd>
              {status.sun.visible_fraction > 0
                ? fmt(status.next_sunset_utc) + hoursUntil(status.time_utc, status.next_sunset_utc)
                : fmt(status.next_sunrise_utc) + hoursUntil(status.time_utc, status.next_sunrise_utc)}
            </dd>
            <dt className="text-slate-400">{status.earth.visible ? 'Next Earthset' : 'Next Earthrise'}</dt>
            <dd>
              {status.earth.visible
                ? fmt(status.next_earthset_utc) + hoursUntil(status.time_utc, status.next_earthset_utc)
                : fmt(status.next_earthrise_utc) + hoursUntil(status.time_utc, status.next_earthrise_utc)}
            </dd>
          </dl>
        )}
      </div>
      {site && (
        <p className="mt-auto text-[11px] text-slate-500">
          {site.lat.toFixed(4)}°, {site.lon.toFixed(4)}°E · ground {Math.round(site.ground_height_m)} m · terrain: Moon
          Trek LOLA · ephemeris: JPL Horizons · drag to orbit, scroll to zoom
        </p>
      )}
    </div>
  )
}
