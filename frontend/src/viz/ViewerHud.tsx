import { useEffect, useState } from 'react'
import { useAppStore } from '../store'
import type { SiteInfo, SiteStatus, TimelineStep } from '../types'
import { vertexSpacingM } from './globe/cubeSphere'
import type { TileStats } from './globe/TileTree'
import { LoadingIndicator } from '../ui/LoadingIndicator'
import { DatePopup } from './DatePopup'
import { fmtDeg, fmtPct, sunUp } from './timeline'
import { useTutorialStore } from '../features/tutorial'

// No next event = none before the site's data ends (the backend only searches the data it has).
const fmt = (iso: string | null, dataStop: string | null | undefined) =>
  iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : `not before ${dataStop ? dataStop.slice(0, 10) : 'the end of the data'}`

function hoursUntil(fromIso: string, toIso: string | null) {
  if (!toIso) return ''
  const h = (Date.parse(toIso) - Date.parse(fromIso)) / 3.6e6
  return h < 48 ? ` (in ${Math.round(h)} h)` : ` (in ${(h / 24).toFixed(1)} d)`
}

// Artemis sites are split by NASA's list naming their region (backend engine/sites.py): the 9 regions of the
// October 2024 update vs the original 13 of 2022 (or a point that can't be placed in either).
const isKind = (kind: string) => (s: SiteInfo) => (s.kind ?? 'custom') === kind
const SITE_GROUPS: [string, string, (s: SiteInfo) => boolean][] = [
  ['artemis', "Artemis III regions (NASA's 2024 list)", (s) => s.kind === 'artemis' && (s.artemis_list ?? '2024') === '2024'],
  ['artemis-2022', 'Earlier Artemis III candidates (2022 list)', (s) => s.kind === 'artemis' && !!s.artemis_list && s.artemis_list !== '2024'],
  ['clps', 'Commercial landers (CLPS)', isKind('clps')],
  ['international', 'Other countries', isKind('international')],
  ['apollo', 'Apollo', isKind('apollo')],
  ['custom', 'Your pins', isKind('custom')],
  ['control', 'Validation control', isKind('control')],
]

/** Default site + keep the selected time inside the site's data range. Call once. */
export function useViewerSetup(sites: SiteInfo[] | null) {
  const { siteId, timeUtc, setSite, setTime } = useAppStore()
  const site = sites?.find((s) => s.id === siteId) ?? null
  // Both checks read the store as it is now, not as it was at render: an earlier effect of the same commit (e.g.
  // "Show why" applying its site and time) must not be overwritten by the default.
  useEffect(() => {
    const cur = useAppStore.getState().siteId
    if (sites?.length && !sites.some((s) => s.id === cur)) setSite((sites.find((s) => s.id === 'connecting-ridge') ?? sites[0]).id)
  }, [sites, site, setSite])
  useEffect(() => {
    const { siteId: sid, timeUtc: t } = useAppStore.getState()
    const s = sites?.find((x) => x.id === sid)
    if (s && (t < s.data_start_utc || t > s.data_stop_utc)) setTime(s.data_start_utc)
  }, [sites, site, timeUtc, setTime])
}

/** The rows of the toolbar's "Select site" menu: every site, grouped, with the current one ticked. */
export function SiteMenuRows({ sites, error, loading, onPicked }: {
  sites: SiteInfo[] | null
  error: string | null
  loading: boolean
  onPicked: () => void // called after a site is chosen (closes the menu)
}) {
  const { siteId, setSite } = useAppStore()
  return (
    <div className="max-h-[min(60vh,30rem)] w-72 max-w-[calc(100vw-2rem)] overflow-y-auto text-sm">
      {error && <p className="px-4 py-2 text-xs text-red-500">{error}. Is the backend running on port 8000?</p>}
      {!error && loading && (
        <p className="flex items-center gap-2 px-4 py-2 text-xs text-slate-400">
          <LoadingIndicator size={20} contained={false} label="Loading" />
          Loading sites…
        </p>
      )}
      {SITE_GROUPS.map(([kind, label, inGroup]) => {
        const group = sites?.filter(inGroup) ?? []
        return group.length ? (
          <div key={kind} role="group" aria-label={label}>
            <p className="px-4 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</p>
            {group.map((s) => {
              const on = s.id === siteId
              return (
                <button
                  key={s.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={on}
                  onClick={() => {
                    setSite(s.id)
                    useTutorialStore.getState().recordInteraction('site-select')
                    onPicked()
                  }}
                  className={`flex min-h-10 w-full items-center gap-3 px-4 py-1.5 text-left transition-colors ${on ? 'bg-coral/15 font-semibold' : ''}`}
                >
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center text-coral">
                    {on && <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" /></svg>}
                  </span>
                  <span className="min-w-0">
                    {s.name}
                    {s.approximate ? ' (approx.)' : ''}
                    {s.artemis_list === 'unconfirmed' ? ' (Rim 1 or 2?)' : ''}
                  </span>
                </button>
              )
            })}
          </div>
        ) : null
      })}
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
                ? fmt(events.next_sunset_utc, site?.data_stop_utc) + hoursUntil(events.time_utc, events.next_sunset_utc)
                : fmt(events.next_sunrise_utc, site?.data_stop_utc) + hoursUntil(events.time_utc, events.next_sunrise_utc)}
          </dd>
          <dt className="text-white/70">{current.earth.visible ? 'Next Earthset' : 'Next Earthrise'}</dt>
          <dd className={events ? '' : 'text-white/60'}>
            {!events
              ? pending
              : current.earth.visible
                ? fmt(events.next_earthset_utc, site?.data_stop_utc) + hoursUntil(events.time_utc, events.next_earthset_utc)
                : fmt(events.next_earthrise_utc, site?.data_stop_utc) + hoursUntil(events.time_utc, events.next_earthrise_utc)}
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
