import { useEffect, useState } from 'react'
import { useAppStore } from '../store'
import type { SiteInfo, SiteStatus, TimelineStep } from '../types'
import { vertexSpacingM } from './globe/cubeSphere'
import type { TileStats } from './globe/TileTree'
import { SelectField } from '../ui/MdFields'
import { DatePopup } from './DatePopup'
import { fmtDeg, fmtPct, sunUp } from './timeline'

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
    <div className="space-y-2 text-xs">
      <SelectField label="Site" tip="The landing site shown in the 3D view and used for the timeline." value={siteId ?? ''} onChange={(e) => setSite(e.target.value)}>
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
      </SelectField>
      {error && <p className="px-4 text-red-400">{error}. Is the backend running on port 8000?</p>}
      {!error && loading && <p className="px-4 text-slate-400">Loading…</p>}
    </div>
  )
}

/**
 * Readout under the title, over the simulation: the time (click to change it), terrain detail and the
 * Sun / Earth conditions at that time.
 */
export function TopInfo({
  sites,
  current,
  events,
  terrainStats,
}: {
  sites: SiteInfo[] | null
  current: TimelineStep | null // conditions at the selected time
  events: SiteStatus | null // next sunset/Earthset etc. (fetched while paused)
  terrainStats?: TileStats | null
}) {
  const playing = useAppStore((s) => s.playing)
  const { siteId, timeUtc, setTime } = useAppStore()
  const site = sites?.find((s) => s.id === siteId) ?? null
  const [calendar, setCalendar] = useState(false)

  const shadow = { textShadow: '0 1px 4px rgba(0,0,0,0.9)' }
  const pending = playing ? 'shown when paused' : '…'

  return (
    <div className="pointer-events-none text-[clamp(11px,0.95vw,13px)] leading-snug text-white" style={{ fontFamily: 'var(--font-inter)', ...shadow }}>
      <p className="flex flex-wrap items-baseline gap-x-3">
        <button
          type="button"
          onClick={() => setCalendar((o) => !o)}
          aria-expanded={calendar}
          aria-label={`Simulation time ${timeUtc.slice(0, 16).replace('T', ' ')} UTC. Click to change.`}
          data-tip="Click to change the time"
          className="pointer-events-auto -my-2 cursor-pointer py-2 font-display underline underline-offset-2 transition-colors duration-200 hover:text-calcite-peach"
        >
          {timeUtc.slice(0, 10)} {timeUtc.slice(11, 16)} UTC
        </button>
        {terrainStats && (
          <span aria-live="polite">
            Terrain: {terrainStats.visible} tiles · finest ~{Math.max(5, Math.round(vertexSpacingM(terrainStats.deepest)))} m
            {terrainStats.loading > 0 ? ` · loading ${terrainStats.loading}…` : ''}
          </span>
        )}
      </p>
      {current && (
        <dl className="md-reveal mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt className="text-white/70">Sunlight</dt>
          <dd>
            {fmtPct(current.sun.visible_fraction, current.sun.visible)} of disk · el{' '}
            {fmtDeg(current.sun.elevation_deg)} vs terrain {fmtDeg(current.sun.horizon_deg)}
          </dd>
          <dt className="text-white/70">Earth</dt>
          <dd>
            {current.earth.visible === null ? 'unknown' : current.earth.visible ? 'in view' : 'blocked'} · margin{' '}
            {fmtDeg(current.earth.margin_deg)}
          </dd>
          <dt className="text-white/70">{sunUp(current.sun) ? 'Next sunset' : 'Next sunrise'}</dt>
          <dd className={events ? '' : 'text-white/60'}>
            {!events
              ? pending
              : sunUp(current.sun)
                ? fmt(events.next_sunset_utc) + hoursUntil(events.time_utc, events.next_sunset_utc)
                : fmt(events.next_sunrise_utc) + hoursUntil(events.time_utc, events.next_sunrise_utc)}
          </dd>
          <dt className="text-white/70">{current.earth.visible ? 'Next Earthset' : 'Next Earthrise'}</dt>
          <dd className={events ? '' : 'text-white/60'}>
            {!events
              ? pending
              : current.earth.visible
                ? fmt(events.next_earthset_utc) + hoursUntil(events.time_utc, events.next_earthset_utc)
                : fmt(events.next_earthrise_utc) + hoursUntil(events.time_utc, events.next_earthrise_utc)}
          </dd>
        </dl>
      )}
      {calendar && site && (
        <DatePopup
          timeUtc={timeUtc}
          min={site.data_start_utc}
          max={site.data_stop_utc}
          onPick={setTime}
          onClose={() => setCalendar(false)}
        />
      )}
    </div>
  )
}
