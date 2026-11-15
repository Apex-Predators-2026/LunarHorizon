// "The plan changed, what now?" Delay / requirement inputs, then ranked, explained
// alternatives, relax-a-requirement suggestions and the closest failing options.
import { resolveHeadroom } from '../../lib/headroom'
import { LoadingIndicator } from '../../ui/LoadingIndicator'
import { TextField } from '../../ui/MdFields'
import { PassHeadroom, PassHeadroomBadge } from '../../ui/PassHeadroom'
import type { ChangeEvent, FormEvent } from 'react'

import { AlternativeCard, DateSlipChecks } from './AlternativeCard'
import { evaluatedTimeNote, fmtShift, fmtUtc, planInfo } from './format'
import { SensitivityView } from './SensitivityView'
import { buildWalkthrough, GLOSSARY, requirementLabel } from './walkthrough'
import { goToView, routeHash } from '../../appRoute'
import { importRescueIntoComparison } from '../compare/RescueImport'
import { usePlansStore } from '../plans/usePlansStore'
import { verdictOf, type Eligibility, type Scenario, type ViabilityResult } from '../../types'
import type { RescueResponse, RescueStatus, SensitivityResponse } from './types'
import { useRescueStore } from './useRescueStore'

const STATUS_STYLE: Record<RescueStatus, string> = {
  still_viable: 'border-emerald-800 bg-emerald-950/40 text-emerald-200',
  rescued: 'border-amber-800 bg-amber-950/40 text-amber-100',
  no_viable_alternative: 'border-red-800 bg-red-950/40 text-red-200',
}
const STATUS_TITLE: Record<RescueStatus, string> = {
  still_viable: 'Plan passes model screening',
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
  const overrides = s.change.requirement_overrides ?? {}
  const loading = s.rescueStatus === 'loading'

  // The results are not shown in the sidebar: once the search is done they open in Scenario Comparison.
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    await s.findAlternatives()
    const now = useRescueStore.getState()
    if (now.rescue && !now.rescueError) {
      importRescueIntoComparison(now.rescue, now.change)
      window.location.hash = routeHash('compare', 'cmp-rescue') // straight to the rescue story and its alternatives
    }
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

const VERDICT_CHIP: Record<Eligibility, string> = {
  pass: 'border-emerald-800 bg-emerald-950 text-emerald-200',
  fail: 'border-red-800 bg-red-950 text-red-200',
  unknown: 'border-slate-600 bg-slate-800 text-slate-200',
}
const VERDICT_WORD: Record<Eligibility, string> = { pass: 'PASS', fail: 'FAIL', unknown: 'UNKNOWN' }

/** Requirement-level difference between the original and the changed plan. Pure: built only from the two results. */
export function whatChanged(res: RescueResponse) {
  const decided = (v: ViabilityResult) => v.violations.filter((x) => !x.is_unknown)
  const before = new Set(decided(res.original).map((v) => v.constraint))
  const after = decided(res.changed)
  const afterSet = new Set(after.map((v) => v.constraint))
  return {
    from: verdictOf(res.original),
    to: verdictOf(res.changed),
    newlyBroken: after.filter((v) => !before.has(v.constraint)),
    stillBroken: after.filter((v) => before.has(v.constraint)),
    fixed: decided(res.original).filter((v) => !afterSet.has(v.constraint)),
    undecided: res.changed.violations.filter((v) => v.is_unknown),
  }
}

/** Original plan -> changed plan: the two canonical verdicts and the requirements that broke, recovered or became
 *  undecided. The Explain walkthrough tells the same story in prose; this is the always-visible summary. */
export function WhatChanged({ res }: { res: RescueResponse }) {
  const d = whatChanged(res)
  const chip = (e: Eligibility) => (
    <span className={`rounded border px-1.5 py-0.5 text-[11px] font-medium ${VERDICT_CHIP[e]}`}>{VERDICT_WORD[e]}</span>
  )
  const row = (label: string, v: ViabilityResult, e: Eligibility) => (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-24 shrink-0 text-slate-500">{label}</span>
      {chip(e)}
      <span className="text-slate-300">
        {v.scenario.site.name}, {fmtUtc(v.scenario.landing_utc)}, {v.scenario.duration_days} d
      </span>
    </div>
  )
  return (
    <section aria-label="What changed" data-testid="rescue-what-changed"
      className="space-y-1.5 rounded-md border border-slate-800 bg-slate-900/40 p-3 text-xs">
      <h3 className="text-sm font-medium text-slate-200">What changed</h3>
      {row('Original plan', res.original, d.from)}
      {row('After the change', res.changed, d.to)}
      {d.from === d.to && d.newlyBroken.length === 0 && d.fixed.length === 0 && d.undecided.length === 0 && (
        <p className="text-slate-400">The canonical verdict did not change.</p>
      )}
      {(d.newlyBroken.length > 0 || d.stillBroken.length > 0) && (
        <ul className="space-y-0.5 text-red-300">
          {d.newlyBroken.map((v) => (
            <li key={v.constraint}>
              <span aria-hidden="true">✕ </span>Newly broken: {requirementLabel(v.constraint)}. {v.message}
            </li>
          ))}
          {d.stillBroken.map((v) => (
            <li key={v.constraint}>
              <span aria-hidden="true">✕ </span>Still broken: {requirementLabel(v.constraint)}. {v.message}
            </li>
          ))}
        </ul>
      )}
      {d.fixed.length > 0 && (
        <ul className="space-y-0.5 text-emerald-300">
          {d.fixed.map((v) => (
            <li key={v.constraint}><span aria-hidden="true">✓ </span>No longer broken: {requirementLabel(v.constraint)}</li>
          ))}
        </ul>
      )}
      {d.undecided.length > 0 && (
        <ul className="space-y-0.5 text-slate-300">
          {d.undecided.map((v) => (
            <li key={v.constraint}>
              <span aria-hidden="true">? </span>Undecided, not a failure: {requirementLabel(v.constraint)}. {v.message.replace(/^UNKNOWN: /, '')}
            </li>
          ))}
        </ul>
      )}
    </section>
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
  const changedHeadroom = res.status === 'still_viable' ? resolveHeadroom(res.changed) : null
  const changedLimited =
    changedHeadroom !== null && (changedHeadroom.status === 'limited' || changedHeadroom.status === 'at_threshold')
  const bannerStyle =
    res.status === 'still_viable' && changedLimited
      ? 'border-amber-800 bg-amber-950/40 text-amber-100'
      : STATUS_STYLE[res.status]

  return (
    <>
      <div role="status" className={`rounded-md border p-3 text-xs ${bannerStyle}`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium">{STATUS_TITLE[res.status]}</h3>
          {changedHeadroom && (
            <PassHeadroomBadge headroom={changedHeadroom} eligibility={verdictOf(res.changed)} surface="planner" />
          )}
        </div>
        <p className="mt-1">{res.summary}</p>
        {changedHeadroom && <PassHeadroom headroom={changedHeadroom} surface="planner" compact className="mt-2" />}
        {res.status === 'still_viable' && res.changed_robustness && (
          <>
            <DateSlipChecks robustness={res.changed_robustness} title="Tested date-slip checks" />
            {res.changed_robustness.verdict !== 'unchecked' && res.changed_robustness.note && (
              <p className="mt-1 text-[11px] opacity-85">{res.changed_robustness.note}</p>
            )}
          </>
        )}
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

      <WhatChanged res={res} />

      <DataNote assumptions={res.assumptions} />

      {explain && <Walkthrough res={res} />}

      {res.alternatives.length > 0 && (
        <details open>
          <summary className="cursor-pointer text-sm font-medium text-slate-200">
            Recommended alternatives ({res.alternatives.length})
          </summary>
          <div className="mt-2 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-slate-400">Meet every original requirement</p>
              <button type="button" onClick={() => goToView('compare')}
                data-tip="Open Scenario Comparison, where you can bring in the original, the changed plan and these alternatives"
                className="shrink-0 rounded border border-slate-700 px-2 py-0.5 text-xs hover:bg-slate-800">
                Compare them
              </button>
            </div>
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
        </details>
      )}

      {sensitivityLoading && <p className="text-xs text-slate-400">Checking sensitivity…</p>}
      {sensitivity && <SensitivityView data={sensitivity} />}

      {res.loosening.length > 0 && (
        <div className="rounded-md border border-slate-800 bg-slate-900/40 p-3 text-xs">
          <h3 className="text-sm font-medium text-slate-200">Or relax a requirement (engineering compromise)</h3>
          <p className="mt-1 text-[11px] text-slate-500">These plans pass only under the relaxed requirement shown, not the original ones.</p>
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
