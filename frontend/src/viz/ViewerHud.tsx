import { useEffect } from 'react'
import { useAppStore } from '../store'
import type { SiteInfo, SiteStatus, TimelineStep } from '../types'
import type { ViewMode } from './CameraRig'
import { vertexSpacingM } from './globe/cubeSphere'
import type { TileStats } from './globe/TileTree'
import { fmtDeg, fmtPct, sunUp } from './timeline'

const toInput = (iso: string) => iso.slice(0, 16) // "2027-01-01T00:00"
const fromInput = (v: string) => `${v}:00Z`
const fmt = (iso: string | null) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : 'not before 2029')

function hoursUntil(fromIso: string, toIso: string | null) {
  if (!toIso) return ''
  const h = (Date.parse(toIso) - Date.parse(fromIso)) / 3.6e6
  return h < 48 ? ` (in ${Math.round(h)} h)` : ` (in ${(h / 24).toFixed(1)} d)`
}

const SITE_GROUPS: [string, string][] = [
  ['artemis', 'Artemis III candidates (south pole)'],
  ['clps', 'Commercial landers (CLPS)'],
  ['international', 'Other countries'],
  ['apollo', 'Apollo'],
  ['custom', 'Your pins'],
  ['control', 'Validation control'],
]

const VIEWS: { id: ViewMode; label: string; title: string }[] = [
  { id: 'globe', label: 'Globe', title: 'The whole Moon' },
  { id: 'region', label: 'Region', title: 'A few hundred km around the site' },
  { id: 'overview', label: 'Site', title: 'A few km around the lander' },
  { id: 'sun', label: 'Sun', title: "Stand behind the lander and look at the Sun" },
  { id: 'earth', label: 'Earth', title: 'Stand behind the lander and look at Earth' },
]

const input =
  'w-full rounded-lg border border-opal-300 bg-white px-2 py-1 text-calcite-ink transition-colors hover:border-calcite-peach'

/** Default site + keep the selected time inside the site's data range. Call once. */
export function useViewerSetup(sites: SiteInfo[] | null) {
  const { siteId, timeUtc, setSite, setTime } = useAppStore()
  const site = sites?.find((s) => s.id === siteId) ?? null
  useEffect(() => {
    if (sites?.length && !site) setSite((sites.find((s) => s.id === 'connecting-ridge') ?? sites[0]).id)
  }, [sites, site, setSite])
  useEffect(() => {
    if (site && (timeUtc < site.data_start_utc || timeUtc > site.data_stop_utc)) setTime(site.data_start_utc)
  }, [site, timeUtc, setTime])
}

/** Site picker (lives in the sidebar), plus backend error / loading status. */
export function SiteSelect({ sites, error, loading }: { sites: SiteInfo[] | null; error: string | null; loading: boolean }) {
  const { siteId, setSite } = useAppStore()
  return (
    <div className="space-y-1 text-xs">
      <label className="block">
        <span className="text-slate-400">Site</span>
        <select className={input} value={siteId ?? ''} onChange={(e) => setSite(e.target.value)}>
          {SITE_GROUPS.map(([kind, label]) => {
            const group = sites?.filter((s) => (s.kind ?? 'custom') === kind) ?? []
            return group.length ? (
              <optgroup key={kind} label={label}>
                {group.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.approximate ? ' (approx.)' : ''}
                  </option>
                ))}
              </optgroup>
            ) : null
          })}
        </select>
      </label>
      {error && <p className="text-red-400">{error}. Is the backend running on port 8000?</p>}
      {!error && loading && <p className="text-slate-400">Loading…</p>}
    </div>
  )
}

/** Time, camera view and conditions at the selected time (lives in the bottom panel). */
export function SimControls({
  sites,
  current,
  events,
  view,
  onView,
  terrainStats,
}: {
  sites: SiteInfo[] | null
  current: TimelineStep | null // conditions at the selected time
  events: SiteStatus | null // next sunset/Earthset etc. (fetched while paused)
  view: ViewMode
  onView: (v: ViewMode) => void
  terrainStats?: TileStats | null
}) {
  const playing = useAppStore((s) => s.playing)
  const { siteId, timeUtc, setTime } = useAppStore()
  const site = sites?.find((s) => s.id === siteId) ?? null

  return (
    <div className="space-y-2 text-xs">
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

      <div className="flex flex-wrap gap-1" role="group" aria-label="Camera view">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            title={v.title}
            onClick={() => onView(v.id)}
            aria-pressed={view === v.id}
            className={`flex-1 rounded-lg border px-1.5 py-1 transition-colors ${
              view === v.id
                ? 'border-coral bg-coral/15 font-semibold text-sky-300'
                : 'border-opal-300 bg-white hover:bg-calcite-peach/40'
            }`}
          >
            {v.label}
          </button>
        ))}
      </div>
      {terrainStats && (
        <p className="text-[10px] text-slate-500" aria-live="polite">
          Terrain: {terrainStats.visible} tiles · finest ~{Math.max(5, Math.round(vertexSpacingM(terrainStats.deepest)))} m
          {terrainStats.loading > 0 ? ` · loading ${terrainStats.loading}…` : ''}
        </p>
      )}

      {current && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          <dt className="text-slate-400">Sunlight</dt>
          <dd>
            {fmtPct(current.sun.visible_fraction, current.sun.visible)} of disk · el{' '}
            {fmtDeg(current.sun.elevation_deg)} vs terrain {fmtDeg(current.sun.horizon_deg)}
          </dd>
          <dt className="text-slate-400">Earth</dt>
          <dd>
            {current.earth.visible === null ? 'unknown' : current.earth.visible ? 'in view' : 'blocked'} · margin{' '}
            {fmtDeg(current.earth.margin_deg)}
          </dd>
          <dt className="text-slate-400">{sunUp(current.sun) ? 'Next sunset' : 'Next sunrise'}</dt>
          <dd className={events ? '' : 'text-slate-500'}>
            {!events
              ? playing
                ? 'shown when paused'
                : '…'
              : sunUp(current.sun)
                ? fmt(events.next_sunset_utc) + hoursUntil(events.time_utc, events.next_sunset_utc)
                : fmt(events.next_sunrise_utc) + hoursUntil(events.time_utc, events.next_sunrise_utc)}
          </dd>
          <dt className="text-slate-400">{current.earth.visible ? 'Next Earthset' : 'Next Earthrise'}</dt>
          <dd className={events ? '' : 'text-slate-500'}>
            {!events
              ? playing
                ? 'shown when paused'
                : '…'
              : current.earth.visible
                ? fmt(events.next_earthset_utc) + hoursUntil(events.time_utc, events.next_earthset_utc)
                : fmt(events.next_earthrise_utc) + hoursUntil(events.time_utc, events.next_earthrise_utc)}
          </dd>
        </dl>
      )}
    </div>
  )
}
