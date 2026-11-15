// "The plan changed, what now?" Delay / requirement inputs, then ranked, explained
// alternatives, relax-a-requirement suggestions and the closest failing options.
import { Icon } from '../compare/ui'
import { LoadingIndicator } from '../../ui/LoadingIndicator'
import { TextField } from '../../ui/MdFields'
import type { ChangeEvent, FormEvent } from 'react'

import { AlternativeCard } from './AlternativeCard'
import { evaluatedTimeNote, fmtShift, fmtUtc, planInfo } from './format'
import { SensitivityView } from './SensitivityView'
import { buildWalkthrough, GLOSSARY } from './walkthrough'
import { usePlansStore } from '../plans/usePlansStore'
import type { Scenario } from '../../types'
import type { RescueResponse, RescueStatus, SensitivityResponse } from './types'
import { useRescueStore } from './useRescueStore'

const STATUS_STYLE: Record<RescueStatus, string> = {
  still_viable: 'border-emerald-800 bg-emerald-950/40 text-emerald-200',
  rescued: 'border-amber-800 bg-amber-950/40 text-amber-100',
  no_viable_alternative: 'border-red-800 bg-red-950/40 text-red-200',
}
const STATUS_TITLE: Record<RescueStatus, string> = {
  still_viable: 'Plan still works',
  rescued: 'Plan broke: alternatives found',
  no_viable_alternative: 'No alternative passes',
}

const num = (e: ChangeEvent<HTMLInputElement>) => (e.target.value === '' ? undefined : Number(e.target.value))

/** One quiet line saying which plan the rescue tools are working on. */
export function RescuingLine({ scenario, name, changed }: { scenario: Scenario; name: string | null; changed: boolean }) {
  return (
    <p className="text-xs text-slate-400">
      {`Rescuing: ${name ? `${name}, ` : ''}${scenario.site.name}, ${fmtUtc(scenario.landing_utc)}, ${scenario.duration_days} ${scenario.duration_days === 1 ? 'day' : 'days'}`}
      {changed && <> This plan changed since; press Run to update.</>}
    </p>
  )
}

/** Where the numbers came from: NASA data credit, or the simulation warning. */
export function DataNote({ assumptions }: { assumptions: string[] }) {
  return (
    <>
      {assumptions[0]?.startsWith('SYNTHETIC') && (
        <p className="rounded border border-amber-900 bg-amber-950/40 p-2 text-[11px] text-amber-200">{assumptions[0]}</p>
      )}
      {assumptions[0]?.startsWith('Real data') && (
        <p className="text-[11px] text-sky-300/80">{assumptions[0]}</p>
      )}
    </>
  )
}

export function RescuePanel() {
  const s = useRescueStore()
  const plans = usePlansStore((p) => p.plans)
  const { name: planName, changed: changedSince } = planInfo(s.original, s.originalPlanId, plans)
  const res = s.rescue
  const overrides = s.change.requirement_overrides ?? {}
  const loading = s.rescueStatus === 'loading'

  const submit = (e: FormEvent) => {
    e.preventDefault()
    void s.findAlternatives()
  }

  return (
    <section aria-label="Mission rescue" className="space-y-3">
      {s.original && <RescuingLine scenario={s.original} name={planName} changed={changedSince} />}
      <form onSubmit={submit} className="grid grid-cols-1 gap-2 text-xs">
        <TextField
          label="Launch delay (days)"
          tip="How many days the launch has slipped. Alternatives are searched from the new landing date."
          type="number" min={0} step={1} value={s.change.launch_delay_days ?? 0}
          onChange={(e) => s.setChange({ launch_delay_days: num(e) ?? 0 })}
        />
        <TextField
          label="New mission length (days)"
          tip="Change how long the mission lasts. Leave empty to keep the original length."
          type="number" min={1} step={1} placeholder="unchanged" value={s.change.new_duration_days ?? ''}
          onChange={(e) => s.setChange({ new_duration_days: num(e) ?? null })}
        />
        <TextField
          label="New battery limit (h)"
          tip="A new longest dark period the battery can survive. Leave empty to keep the plan's value."
          type="number" min={1} placeholder="unchanged" value={overrides.battery_hours ?? ''}
          onChange={(e) => s.setChange({ requirement_overrides: { ...overrides, battery_hours: num(e) } })}
        />
        <TextField
          label="New max comms blackout (h)"
          tip="A new longest allowed stretch without Earth contact. Leave empty to keep the plan's value."
          type="number" min={1} placeholder="unchanged" value={overrides.max_comms_gap_hours ?? ''}
          onChange={(e) => s.setChange({ requirement_overrides: { ...overrides, max_comms_gap_hours: num(e) } })}
        />
        <TextField
          label="Search up to (days after new date)"
          tip="How far past the new landing date to look for alternative landing times."
          type="number" min={0} max={365} value={s.search.date_window_days ?? 30}
          onChange={(e) => s.setSearch({ date_window_days: num(e) ?? 30 })}
        />
        <TextField
          label="Reason (optional)"
          tip="A note on why the plan changed. It is only a label and does not change the results."
          type="text" placeholder="e.g. launch slipped" value={s.change.reason ?? ''}
          onChange={(e) => s.setChange({ reason: e.target.value || null })}
        />
        <label className="flex items-center gap-4 py-2 text-slate-400" data-tip="Fills gaps with made-up placeholder data where no real data exists. Results are not real.">
          <input type="checkbox" checked={s.search.include_synthetic === true}
            onChange={(e) => s.setSearch({ include_synthetic: e.target.checked ? true : null })} />
          Simulation mode: use synthetic placeholder data where there is no real data (not real results)
        </label>
        <button type="submit" disabled={loading || !s.original}
          data-tip="Search for other landing sites and dates that still meet the requirements."
          className="md-btn bg-sky-600 text-white hover:bg-sky-500 disabled:opacity-50">
          {loading ? <><LoadingIndicator size={20} contained={false} color="#ffffff" label="Searching" /><span className="ml-2">Searching…</span></> : 'Find alternatives'}
        </button>
      </form>

      {(s.rescueError ?? s.sensitivityError) && (
        <p role="alert" className="rounded border border-red-900 bg-red-950/50 p-2 text-xs text-red-300">{s.rescueError ?? s.sensitivityError}</p>
      )}

      {res && (
        <button type="button" role="switch" aria-checked={s.showOnMap} data-no-ripple
          data-tip="Draw the alternatives and the failing plan as pins on the 3D map."
          onClick={() => s.setShowOnMap(!s.showOnMap)}
          className="md-row flex h-10 w-full items-center gap-3 rounded-full px-3 text-sm text-ink-2">
          <span className="md-switch" aria-hidden="true">
            <span className="md-switch-handle"><Icon name="check" size={16} /></span>
          </span>
          Show on map
        </button>
      )}

      {res && (
        <button type="button" role="switch" aria-checked={s.explain} data-no-ripple
          data-tip="Show a short step-by-step explanation of what rescue did and why."
          onClick={() => s.setExplain(!s.explain)}
          className="md-row flex h-10 w-full items-center gap-3 rounded-full px-3 text-sm text-ink-2">
          <span className="md-switch" aria-hidden="true">
            <span className="md-switch-handle"><Icon name="check" size={16} /></span>
          </span>
          Explain
        </button>
      )}

      {res && (
        <RescueResults
          res={res}
          requestedLanding={s.original?.landing_utc}
          explain={s.explain}
          selected={s.selected}
          sensitivity={s.sensitivityStatus === 'done' ? s.sensitivity : null}
          sensitivityLoading={s.sensitivityStatus === 'loading'}
          onSelect={s.select}
          onCheckSensitivity={(sc) => void s.checkSensitivity(sc)}
        />
      )}
    </section>
  )
}

/** Educator mode: numbered story of the result and a small glossary. */
export function Walkthrough({ res }: { res: RescueResponse }) {
  return (
    <div className="rounded-md border border-slate-800 bg-slate-900/40 p-3 text-xs">
      <h3 className="text-sm font-medium text-slate-200">What rescue did</h3>
      <ol className="mt-2 list-decimal space-y-2 pl-4 text-slate-300">
        {buildWalkthrough(res).map((st) => (
          <li key={st.title}>
            <strong className="text-slate-100">{st.title}.</strong> {st.text}
          </li>
        ))}
      </ol>
      <details className="mt-3">
        <summary className="cursor-pointer font-medium text-slate-200">Terms used here</summary>
        <dl className="mt-2 space-y-1.5 text-slate-300">
          {GLOSSARY.map((g) => (
            <div key={g.term}>
              <dt className="inline font-medium text-slate-100">{g.term}: </dt>
              <dd className="inline">{g.definition}</dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  )
}

interface ResultsProps {
  res: RescueResponse
  /** The landing time the user entered (before rounding to the hourly grid). */
  requestedLanding?: string
  /** Educator mode: show the walkthrough above the alternatives. */
  explain?: boolean
  selected: Scenario | null
  sensitivity: SensitivityResponse | null
  sensitivityLoading?: boolean
  onSelect: (s: Scenario) => void
  onCheckSensitivity: (s: Scenario) => void
}

/** Pure display of a RescueResponse (no store access), so other views can reuse it. */
export function RescueResults({ res, requestedLanding, explain, selected, sensitivity, sensitivityLoading, onSelect, onCheckSensitivity }: ResultsProps) {
  return (
    <>
      <div role="status" className={`rounded-md border p-3 text-xs ${STATUS_STYLE[res.status]}`}>
        <h3 className="text-sm font-medium">{STATUS_TITLE[res.status]}</h3>
        <p className="mt-1">{res.summary}</p>
        {evaluatedTimeNote(requestedLanding, res.original.scenario.landing_utc) && (
          <p className="mt-1 opacity-70">{evaluatedTimeNote(requestedLanding, res.original.scenario.landing_utc)}</p>
        )}
        <p className="mt-1 opacity-70">
          Checked {res.stats.candidates_evaluated} site/date combinations at {res.stats.locations_considered} locations;{' '}
          {res.stats.passing} pass.
          {res.stats.synthetic_candidates_excluded > 0 && (
            <> {`${res.stats.synthetic_candidates_excluded} more options skipped: no real data there (simulation mode can estimate them).`}</>
          )}
          {res.stats.undecided > 0 && <> {res.stats.undecided} could not be checked (missing data).</>}
        </p>
      </div>

      <DataNote assumptions={res.assumptions} />

      {explain && <Walkthrough res={res} />}

      {res.alternatives.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-slate-200">Recommended alternatives</h3>
          {res.alternatives.map((a) => (
            <AlternativeCard
              key={`${a.scenario.site.id}@${a.scenario.landing_utc}`}
              alt={a}
              selected={selected === a.scenario}
              onSelect={() => onSelect(a.scenario)}
              onCheckSensitivity={() => onCheckSensitivity(a.scenario)}
            />
          ))}
        </div>
      )}

      {sensitivityLoading && <p className="text-xs text-slate-400">Checking sensitivity…</p>}
      {sensitivity && <SensitivityView data={sensitivity} />}

      {res.loosening.length > 0 && (
        <div className="rounded-md border border-slate-800 bg-slate-900/40 p-3 text-xs">
          <h3 className="text-sm font-medium text-slate-200">Or relax a requirement</h3>
          <ul className="mt-2 space-y-2">
            {res.loosening.map((l) => (
              <li key={l.message} className="flex items-start justify-between gap-3 text-slate-300">
                <span>
                  {l.keeps_original_plan && <strong className="mr-1 text-slate-100">Keep your plan:</strong>}
                  {l.message}
                </span>
                <button type="button" onClick={() => onSelect(l.unlocks)}
                  className="shrink-0 rounded border border-slate-700 px-2 py-0.5 hover:bg-slate-800">
                  Show
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {res.near_misses.length > 0 && (
        <details className="rounded-md border border-slate-800 bg-slate-900/40 p-3 text-xs">
          <summary className="cursor-pointer text-sm font-medium text-slate-200">
            Closest options that fail ({res.near_misses.length})
          </summary>
          <ul className="mt-2 space-y-1.5 text-slate-300">
            {res.near_misses.map((n) => (
              <li key={`${n.scenario.site.id}@${n.scenario.landing_utc}`}>
                <span className="text-slate-100">{n.scenario.site.name}</span>, {fmtUtc(n.scenario.landing_utc)} (
                {fmtShift(n.date_shift_hours)}): {n.why_it_fails.join(' ')}
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  )
}
