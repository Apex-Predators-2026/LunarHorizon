// Inline editor for one scenario: location, schedule, spacecraft and mission requirements.
import type { ReactNode } from 'react'

import type { MissionRequirements } from '../../types'
import { fmtUtc, fromUtcInput, toUtcInput } from '../rescue/format'
import { PANEL_MODE_LABEL, autoName, missionEnd, validateScenario } from './scenario'
import type { ComparisonScenario, PanelMode, SpacecraftConfig } from './types'
import { input, Icon } from './ui'
import { useCompareStore } from './useCompareStore'

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block text-[11px] text-slate-400">
      <span className="mb-0.5 block">{label}</span>
      {children}
      {hint && <span className="mt-0.5 block text-[11px] text-slate-500">{hint}</span>}
    </label>
  )
}

const num = (v: string): number | null => (v.trim() === '' ? null : Number(v))

export function ScenarioEditor({ s }: { s: ComparisonScenario }) {
  const update = useCompareStore((st) => st.updateScenario)
  const sites = useCompareStore((st) => st.sites)
  const sitesStatus = useCompareStore((st) => st.sitesStatus)
  const problems = validateScenario(s)
  const auto = s.name === autoName(s.site, s.landing_utc, s.duration_days)

  // Keep auto-generated names in step with the inputs.
  const patch = (p: Partial<ComparisonScenario>) => {
    const next = { ...s, ...p }
    update(s.id, auto && p.name === undefined ? { ...p, name: autoName(next.site, next.landing_utc, next.duration_days) } : p)
  }
  const req = (k: keyof MissionRequirements, v: number | null) =>
    v !== null && Number.isFinite(v) && patch({ requirements: { ...s.requirements, [k]: v } })
  const craft = (p: Partial<SpacecraftConfig>) => patch({ spacecraft: { ...s.spacecraft, ...p } })
  const siteInfo = sites.find((x) => x.id === s.site.id)
  const endurance = s.spacecraft.battery_capacity_wh && s.spacecraft.average_load_w
    ? s.spacecraft.battery_capacity_wh / s.spacecraft.average_load_w : null

  return (
    <div className="mt-3 grid gap-4 border-t border-line pt-3 lg:grid-cols-4">
      <fieldset className="space-y-2">
        <legend className="mb-1 text-xs font-medium text-slate-200">Location</legend>
        <Field label="Name">
          <input className={input} value={s.name} onChange={(e) => patch({ name: e.target.value })} />
        </Field>
        <Field label="Landing site" hint={sitesStatus === 'error' ? 'Backend unavailable: showing the curated sites only.' : undefined}>
          <select className={input} value={s.site.id}
            onChange={(e) => {
              const n = sites.find((x) => x.id === e.target.value)
              if (n) patch({ site: { id: n.id, name: n.name, lat: n.lat, lon: n.lon } })
            }}>
            {!sites.some((x) => x.id === s.site.id) && <option value={s.site.id}>{s.site.name} (imported)</option>}
            {sites.map((x) => (
              <option key={x.id} value={x.id}>{x.name}{x.isControl ? ' — validation control' : ''}</option>
            ))}
          </select>
        </Field>
        <dl className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[11px]">
          <dt className="text-slate-500">Latitude</dt><dd className="tabular-nums text-slate-300">{s.site.lat.toFixed(5)}°</dd>
          <dt className="text-slate-500">Longitude</dt><dd className="tabular-nums text-slate-300">{s.site.lon.toFixed(5)}°E</dd>
          <dt className="text-slate-500">Elevation</dt>
          <dd className="tabular-nums text-slate-300">{siteInfo?.ground_height_m != null ? `${Math.round(siteInfo.ground_height_m)} m` : 'n/a'}</dd>
          {siteInfo?.summary && (<>
            <dt className="text-slate-500">Terrain horizon</dt>
            <dd className="tabular-nums text-slate-300">{siteInfo.summary.horizon_min_deg?.toFixed(1) ?? 'n/a'}° … {siteInfo.summary.horizon_max_deg?.toFixed(1) ?? 'n/a'}°</dd>
          </>)}
        </dl>
        {siteInfo?.source && <p className="text-[11px] leading-snug text-slate-500">Coordinates: {siteInfo.source}</p>}
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="mb-1 text-xs font-medium text-slate-200">Mission schedule</legend>
        <Field label="Landing (UTC)" hint={siteInfo?.dataRange ? `Real data: ${siteInfo.dataRange[0].slice(0, 10)} → ${siteInfo.dataRange[1].slice(0, 10)}` : undefined}>
          <input type="datetime-local" className={input} value={toUtcInput(s.landing_utc)}
            onChange={(e) => e.target.value && patch({ landing_utc: fromUtcInput(e.target.value) })} />
        </Field>
        <Field label="Mission duration (days)">
          <input type="number" min={0.5} max={365} step={0.5} className={input} value={s.duration_days}
            onChange={(e) => { const v = num(e.target.value); if (v !== null && v > 0) patch({ duration_days: v }) }} />
        </Field>
        <p className="text-[11px] text-slate-400">Start {fmtUtc(s.landing_utc)}<br />End {fmtUtc(missionEnd(s))}</p>
        <Field label="Notes">
          <textarea className={`${input} h-14 resize-none text-xs`} value={s.notes ?? ''} onChange={(e) => patch({ notes: e.target.value })} />
        </Field>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="mb-1 text-xs font-medium text-slate-200">Spacecraft (example values — edit)</legend>
        <Field label="Solar panel configuration">
          <select className={input} value={s.spacecraft.panel_mode} onChange={(e) => craft({ panel_mode: e.target.value as PanelMode })}>
            {Object.entries(PANEL_MODE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        {s.spacecraft.panel_mode === 'vertical_fixed' && (
          <Field label="Panel faces azimuth (° from north)">
            <input type="number" min={0} max={359} className={input} value={s.spacecraft.panel_azimuth_deg}
              onChange={(e) => craft({ panel_azimuth_deg: ((num(e.target.value) ?? 0) % 360 + 360) % 360 })} />
          </Field>
        )}
        <div className="grid grid-cols-2 gap-2">
          <Field label="Rated panel power (W)">
            <input type="number" min={0} className={input} value={s.spacecraft.panel_rated_power_w ?? ''}
              onChange={(e) => craft({ panel_rated_power_w: num(e.target.value) || null })} />
          </Field>
          <Field label="Average load (W)">
            <input type="number" min={0} className={input} value={s.spacecraft.average_load_w ?? ''}
              onChange={(e) => craft({ average_load_w: num(e.target.value) || null })} />
          </Field>
        </div>
        <Field label="Battery capacity (Wh)" hint={endurance ? `≈ ${endurance.toFixed(0)} h at the average load` : undefined}>
          <input type="number" min={0} className={input} value={s.spacecraft.battery_capacity_wh ?? ''}
            onChange={(e) => craft({ battery_capacity_wh: num(e.target.value) || null })} />
        </Field>
        {endurance && Math.abs(endurance - s.requirements.battery_hours) > 0.5 && (
          <button type="button" className="text-[11px] text-cyan-400 hover:underline"
            onClick={() => req('battery_hours', Math.round(endurance))}>
            Use {Math.round(endurance)} h as the max acceptable darkness
          </button>
        )}
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="mb-1 text-xs font-medium text-slate-200">Mission requirements</legend>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Max darkness (h)" hint="battery_hours">
            <input type="number" min={1} className={input} value={s.requirements.battery_hours}
              onChange={(e) => req('battery_hours', num(e.target.value))} />
          </Field>
          <Field label="Max blackout (h)" hint="max_comms_gap_hours">
            <input type="number" min={1} className={input} value={s.requirements.max_comms_gap_hours}
              onChange={(e) => req('max_comms_gap_hours', num(e.target.value))} />
          </Field>
          <Field label="Min sunlight (%)">
            <input type="number" min={0} max={100} className={input} value={Math.round(s.requirements.min_sunlight_fraction * 100)}
              onChange={(e) => { const v = num(e.target.value); req('min_sunlight_fraction', v === null ? null : v / 100) }} />
          </Field>
          <Field label="Min Earth visibility (%)">
            <input type="number" min={0} max={100} className={input} value={Math.round(s.requirements.min_earth_visibility_fraction * 100)}
              onChange={(e) => { const v = num(e.target.value); req('min_earth_visibility_fraction', v === null ? null : v / 100) }} />
          </Field>
          <Field label="Panel dark below (% disk)">
            <input type="number" min={0} max={100} className={input} value={Math.round(s.requirements.panel_threshold * 100)}
              onChange={(e) => { const v = num(e.target.value); req('panel_threshold', v === null ? null : v / 100) }} />
          </Field>
          <Field label="Sun after landing (h)">
            <input type="number" min={0} className={input} value={s.requirements.min_initial_sun_hours}
              onChange={(e) => req('min_initial_sun_hours', num(e.target.value))} />
          </Field>
          <Field label="Comms after landing (h)">
            <input type="number" min={0} className={input} value={s.requirements.min_initial_comms_hours}
              onChange={(e) => req('min_initial_comms_hours', num(e.target.value))} />
          </Field>
        </div>
      </fieldset>
      {problems.length > 0 && (
        <p role="alert" className="text-xs text-red-300 lg:col-span-4"><Icon name="warning" size={14} className="mr-1 align-[-2px]" />{problems.join(' ')}</p>
      )}
    </div>
  )
}
