// The plan to rescue: site, landing time, duration, requirements.
// Stand-in until the mission configuration panel exists; that panel can replace this by
// calling useRescueStore.getState().setOriginal(scenario).
import { useEffect, useState, type FormEvent } from 'react'

import { useAppStore } from '../../store'
import { DEFAULT_REQUIREMENTS, type MissionRequirements, type RequirementKey } from '../../types'
import { errorMessage, fetchRescueCatalog } from './api'
import { DateField, SelectField, TextField } from '../../ui/MdFields'
import { DatePopup } from '../../viz/DatePopup'
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

const REQUIREMENT_TIPS: Record<RequirementKey, string> = {
  min_sunlight_fraction: 'The least average share of the mission the Sun must be up, for solar power.',
  battery_hours: 'The longest stretch of darkness the battery can carry the lander through.',
  panel_threshold: 'Below this share of full sunlight the solar panels count as being in the dark.',
  min_earth_visibility_fraction: 'The least share of the mission that Earth must be in view, for communications.',
  max_comms_gap_hours: 'The longest allowed stretch with no line of sight to Earth.',
  min_initial_sun_hours: 'Hours of continuous sunlight needed right after landing.',
  min_initial_comms_hours: 'Hours of Earth contact needed right after landing.',
}

export function PlanForm() {
  const original = useRescueStore((s) => s.original)
  const setOriginal = useRescueStore((s) => s.setOriginal)

  const [catalog, setCatalog] = useState<RescueCatalog | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [siteId, setSiteId] = useState(original?.site.id ?? '')
  const [landing, setLanding] = useState(toUtcInput(original?.landing_utc ?? '2027-10-15T00:00:00Z'))
  const [calendar, setCalendar] = useState(false)
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
      <SelectField
        label="Landing site"
        tip="Where the lander touches down. Pick a candidate site to plan the mission for."
        value={siteId}
        onChange={(e) => setSiteId(e.target.value)}
        disabled={!catalog}
      >
        {catalog?.sites.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
            {s.has_real_data ? '' : ' (no real data: simulation only)'}
          </option>
        ))}
      </SelectField>
      {site && (
        <p className="text-slate-500">
          {site.description}
          {site.has_real_data
            ? ' Real Horizons + LOLA data covers 2027-01-01 to 2029-01-01; missions outside that are reported as unknown.'
            : ' No real data yet: results are unknown unless simulation mode is on.'}
        </p>
      )}
      <div className="grid grid-cols-1 gap-2">
        <div>
          <DateField
            label="Landing (UTC)"
            tip="Planned landing date and time (UTC). Opens a date picker."
            value={landing.replace('T', ' ')}
            expanded={calendar}
            onOpen={() => setCalendar((o) => !o)}
          />
          {calendar && (
            <DatePopup
              timeUtc={fromUtcInput(landing)}
              min="0000-01-01T00:00:00Z"
              max="9999-12-31T23:59:00Z"
              onPick={(iso) => setLanding(toUtcInput(iso))}
              onClose={() => setCalendar(false)}
            />
          )}
        </div>
        <TextField
          label="Mission length (days)"
          tip="How many days the mission lasts after landing."
          type="number" min={1} max={365} step={1} required value={duration}
          onChange={(e) => setDuration(Number(e.target.value))}
        />
      </div>
      <details className="rounded border border-slate-800 p-2">
        <summary className="cursor-pointer text-slate-300" data-tip="What the spacecraft needs to survive and communicate: sunlight, battery, Earth contact. The plan is checked against these.">Spacecraft requirements</summary>
        <div className="mt-2 grid grid-cols-1 gap-2">
          {REQUIREMENT_FIELDS.map((f) => (
            <TextField
              key={f.key}
              label={f.label}
              tip={REQUIREMENT_TIPS[f.key]}
              type="number"
              min={0}
              max={f.percent ? 100 : undefined}
              step={f.step}
              value={f.percent ? Math.round(req[f.key] * 100) : req[f.key]}
              onChange={(e) => {
                const v = Number(e.target.value)
                setReq({ ...req, [f.key]: f.percent ? v / 100 : v })
              }}
            />
          ))}
        </div>
      </details>
      <button type="submit" disabled={!site} data-tip="Save this plan and show it on the map and in the timeline." className="w-full rounded border border-slate-600 py-1.5 text-slate-200 hover:bg-slate-800 disabled:opacity-50">
        {original ? 'Update plan' : 'Set plan'}
      </button>
    </form>
  )
}
