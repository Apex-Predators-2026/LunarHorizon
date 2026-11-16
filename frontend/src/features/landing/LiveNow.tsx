// "Right now at the south pole": the real conditions at three Artemis III sites for the current hour, from the
// backend's precomputed JPL Horizons + LOLA timelines (GET /api/sites/{id}/status). Without the server it says so.
import { useEffect, useState } from 'react'

import { GlassSurface } from '../../ui/GlassSurface'
import { currentHourIso, describeEarth, describeSun, type Status, untilText } from './liveFormat'

const SITES = [
  { id: 'connecting-ridge', name: 'Connecting Ridge' },
  { id: 'peak-near-shackleton', name: 'Peak near Shackleton' },
  { id: 'malapert-massif', name: 'Malapert Massif' },
] as const

// One request per site and hour, shared by every LiveNow on the page.
const cache = new Map<string, Promise<Status>>()
export function fetchStatus(site: string, time: string) {
  const apiBase: string = import.meta.env.VITE_API_URL ?? ''
  const key = `${apiBase}|${site}@${time}`
  let p = cache.get(key)
  if (!p) {
    p = fetch(`${apiBase}/api/sites/${site}/status?time=${encodeURIComponent(time)}`).then((r) =>
      r.ok ? r.json() : Promise.reject(new Error(String(r.status))),
    )
    p.catch(() => cache.delete(key))
    cache.set(key, p)
  }
  return p
}

export function LiveNow({ idPrefix = 'lnd-live' }: { idPrefix?: string }) {
  const [site, setSite] = useState<(typeof SITES)[number]['id']>('connecting-ridge')
  const [state, setState] = useState<{ site: string; data?: Status; error?: boolean }>({ site: '' })
  const time = currentHourIso()

  useEffect(() => {
    let live = true
    fetchStatus(site, time)
      .then((data) => live && setState({ site, data }))
      .catch(() => live && setState({ site, error: true }))
    return () => {
      live = false
    }
  }, [site, time])

  const loading = state.site !== site
  const data = loading ? undefined : state.data
  const sunUp = data?.sun.visible
  const when = new Date(time).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })

  return (
    <GlassSurface radius="24px" className="lnd-glass-dark lnd-live" aria-labelledby={`${idPrefix}-h`}>
      <div className="lnd-live-head">
        <h2 id={`${idPrefix}-h`}>Right now at the south pole</h2>
        <span className="lnd-live-time">{when} UTC</span>
      </div>
      <div role="radiogroup" aria-label="Site" className="lnd-seg">
        {SITES.map((s) => (
          <button key={s.id} type="button" role="radio" aria-checked={site === s.id} onClick={() => setSite(s.id)}>
            {s.name}
          </button>
        ))}
      </div>
      {state.error && !loading ? (
        <p className="lnd-live-note">Live conditions need the navigator’s server, which isn’t reachable right now.</p>
      ) : (
        <dl className="lnd-live-rows" aria-live="polite" aria-busy={loading}>
          <>
            <div>
              <dt><span className="lnd-dot" style={{ background: '#e8b84a' }} aria-hidden /> Sun</dt>
              <dd>{data ? describeSun(data.sun) : 'Loading'}</dd>
            </div>
            <div>
              <dt><span className="lnd-dot" style={{ background: '#5aa9f0' }} aria-hidden /> Earth</dt>
              <dd>{data ? describeEarth(data.earth) : 'Loading'}</dd>
            </div>
            <div>
              <dt><span className="lnd-dot" style={{ background: 'rgba(245,245,247,0.5)' }} aria-hidden /> Next</dt>
              <dd>
                {data
                  ? sunUp
                    ? `Sunset ${untilText(data.next_sunset_utc)}`
                    : `Sunrise ${untilText(data.next_sunrise_utc)}`
                  : 'Loading'}
              </dd>
            </div>
          </>
        </dl>
      )}
      <p className="lnd-live-src">JPL Horizons and LOLA terrain, hourly data</p>
    </GlassSurface>
  )
}
