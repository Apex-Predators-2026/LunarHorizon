// The plan to rescue: site, landing time, duration, requirements.
// Stand-in until the mission configuration panel exists; that panel can replace this by
// calling useRescueStore.getState().setOriginal(scenario).
import { useEffect, useState, type FormEvent } from 'react'

import { useAppStore } from '../../store'
import { DEFAULT_REQUIREMENTS, type MissionRequirements, type RequirementKey } from '../../types'
import { errorMessage, fetchRescueCatalog } from './api'
import { fromUtcInput, toUtcInput } from './format'
import type { RescueCatalog } from './types'
import { useRescueStore } from './useRescueStore'

const REQUIREMENT_FIELDS: { key: RequirementKey; label: string; step: number; percent?: boolean }[] = [
  { key: 'min_sunlight_fraction', label: 'Min average sunlight (%)', step: 5, percent: true },
  { key: 'battery_hours', label: 'Battery: longest dark period (h)', step: 1 },
  { key: 'panel_threshold', label: 'Panels count as dark below (% of Sun)', step: 5, percent: true },
  { key: 'min_earth_visibility_fraction', label: 'Min Earth visibility (%)', step: 5, percent: true },
  { key: 'max_comms_gap_hours', label: 'Max comms blackout (h)', step: 1 },
  { key: 'min_initial_sun_hours', label: 'Sunlight needed after landing (h)', step: 1 },
  { key: 'min_initial_comms_hours', label: 'Earth contact needed after landing (h)', step: 1 },
]

const inputCls = 'rounded border border-slate-700 bg-slate-950 px-2 py-1 text-slate-100'

export function PlanForm() {
  const original = useRescueStore((s) => s.original)
  const setOriginal = useRescueStore((s) => s.setOriginal)

  const [catalog, setCatalog] = useState<RescueCatalog | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [siteId, setSiteId] = useState(original?.site.id ?? '')
  const [landing, setLanding] = useState(toUtcInput(original?.landing_utc ?? '2027-10-15T00:00:00Z'))
  const [duration, setDuration] = useState(original?.duration_days ?? 7)
  const [req, setReq] = useState<MissionRequirements>(original?.requirements ?? DEFAULT_REQUIREMENTS)

  // Load the site list once; start on the site the rest of the app has selected, if any.
  useEffect(() => {
    const ctl = new AbortController()
    fetchRescueCatalog(ctl.signal)
      .then((c) => {
        setCatalog(c)
        const appSite = useAppStore.getState().siteId
        setSiteId((cur) => cur || (c.sites.find((s) => s.id === appSite) ?? c.sites[0])?.id || '')
      })
      .catch((e) => {
        if (!ctl.signal.aborted) setLoadError(errorMessage(e))
      })
    return () => ctl.abort()
  }, [])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const site = catalog?.sites.find((s) => s.id === siteId)
    if (!site) return
    const landing_utc = fromUtcInput(landing)
    setOriginal({
      site: { id: site.id, name: site.name, lat: site.lat, lon: site.lon },
      landing_utc,
      duration_days: duration,
      requirements: req,
    })
    const app = useAppStore.getState()
    app.setSite(site.id)
    app.setTime(landing_utc)
  }

  if (loadError) {
    return (
      <p role="alert" className="rounded border border-red-900 bg-red-950/50 p-2 text-xs text-red-300">
        Could not load sites from the backend ({loadError}). Is it running? (cd backend; uvicorn app.main:app --reload)
      </p>
    )
  }

  const site = catalog?.sites.find((s) => s.id === siteId)

  return (
    <form onSubmit={submit} className="space-y-2 text-xs">
      <label className="flex flex-col gap-1 text-slate-400">
        Landing site
        <select value={siteId} onChange={(e) => setSiteId(e.target.value)} className={inputCls} disabled={!catalog}>
          {catalog?.sites.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
              {s.has_real_data ? '' : ' (synthetic data)'}
            </option>
          ))}
        </select>
      </label>
      {site && (
        <p className="text-slate-500">
          {site.description}
          {site.has_real_data ? ' Real Horizons + LOLA data (2027–2028).' : ' No real data yet: results are synthetic.'}
        </p>
      )}
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1 text-slate-400">
          Landing (UTC)
          <input type="datetime-local" required value={landing} onChange={(e) => setLanding(e.target.value)} className={inputCls} />
        </label>
        <label className="flex flex-col gap-1 text-slate-400">
          Mission length (days)
          <input type="number" min={1} max={365} step={1} required value={duration}
            onChange={(e) => setDuration(Number(e.target.value))} className={inputCls} />
        </label>
      </div>
      <details className="rounded border border-slate-800 p-2">
        <summary className="cursor-pointer text-slate-300">Spacecraft requirements</summary>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {REQUIREMENT_FIELDS.map((f) => (
            <label key={f.key} className="flex flex-col gap-1 text-slate-400">
              {f.label}
              <input
                type="number"
                min={0}
                max={f.percent ? 100 : undefined}
                step={f.step}
                value={f.percent ? Math.round(req[f.key] * 100) : req[f.key]}
                onChange={(e) => {
                  const v = Number(e.target.value)
                  setReq({ ...req, [f.key]: f.percent ? v / 100 : v })
                }}
                className={inputCls}
              />
            </label>
          ))}
        </div>
      </details>
      <button type="submit" disabled={!site} className="w-full rounded border border-slate-600 py-1.5 text-slate-200 hover:bg-slate-800 disabled:opacity-50">
        {original ? 'Update plan' : 'Set plan'}
      </button>
    </form>
  )
}
