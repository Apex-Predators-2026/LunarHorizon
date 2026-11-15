// Plan analysis on the comparison page: the viability engine's full Mission assessment of one compared plan, its
// data / assumptions / limitations, and the Science vs engineering compromise search. These used to live in the
// Planner's sidebar; here they work on the plans being compared and share the page's scenario colours.
import { useMemo } from 'react'
import { create } from 'zustand'

import { useAssessment } from '../../lib/assessment'
import type { Scenario } from '../../types'
import { AssessmentPanel } from '../assessment/AssessmentPanel'
import { CompromisePanel } from '../rescue/CompromisePanel'
import type { Entry } from './analysis'
import { toTeamScenario } from './scenario'
import { Empty, ScenarioChip } from './ui'
import { useCompareStore } from './useCompareStore'

/** Which compared plan the analysis blocks look at (shared, so the three blocks follow one choice). */
const useAnalysisPick = create<{ id: string | null; set: (id: string) => void }>((set) => ({ id: null, set: (id) => set({ id }) }))

function usePicked(entries: Entry[]): Entry | null {
  const id = useAnalysisPick((s) => s.id)
  const baselineId = useCompareStore((s) => s.baselineId)
  return entries.find((e) => e.scenario.id === id) ?? entries.find((e) => e.scenario.id === baselineId) ?? entries[0] ?? null
}

function PlanPicker({ entries, picked, label }: { entries: Entry[]; picked: Entry; label: string }) {
  const pick = useAnalysisPick((s) => s.set)
  if (entries.length < 2) {
    return (
      <p className="mb-3 flex items-center gap-1.5 text-xs text-ink-3">
        <ScenarioChip s={picked.scenario} size="sm" /> <span>{picked.scenario.name}</span>
      </p>
    )
  }
  return (
    <div role="radiogroup" aria-label={label} className="mb-4 flex flex-wrap items-center gap-2">
      <span className="text-xs text-ink-3">Plan</span>
      {entries.map((e) => {
        const on = e.scenario.id === picked.scenario.id
        return (
          <button key={e.scenario.id} type="button" role="radio" aria-checked={on} onClick={() => pick(e.scenario.id)}
            data-tip={e.scenario.name}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors ${on ? 'border-coral bg-coral/10 text-ink' : 'border-line text-ink-3 hover:bg-inset'}`}>
            <ScenarioChip s={e.scenario} size="sm" />
            <span className="max-w-[12rem] truncate">{e.scenario.name}</span>
          </button>
        )
      })}
    </div>
  )
}

function AssessmentFor({ entries, picked, part }: { entries: Entry[]; picked: Entry; part: 'assessment' | 'data' }) {
  const sc = useMemo(() => toTeamScenario(picked.scenario), [picked.scenario])
  const state = useAssessment(sc)
  return (
    <div>
      <PlanPicker entries={entries} picked={picked} label={part === 'assessment' ? 'Plan to assess' : 'Plan whose data to show'} />
      <AssessmentPanel state={state} part={part}
        origin={{ kind: 'comparison', label: `Scenario ${picked.scenario.label}`, section: part === 'assessment' ? 'cmp-assessment' : 'cmp-assumptions' }} />
    </div>
  )
}

/** The engine's full assessment (verdict, every requirement with its evidence, screening risks) for the picked plan. */
export function MissionAssessmentBlock({ entries }: { entries: Entry[] }) {
  const picked = usePicked(entries)
  if (!picked) return <Empty>Select a scenario to see its mission assessment.</Empty>
  return <AssessmentFor entries={entries} picked={picked} part="assessment" />
}

/** The data behind that assessment: provenance, coverage, assumptions, limitations and method versions. */
export function DataAssumptionsBlock({ entries }: { entries: Entry[] }) {
  const picked = usePicked(entries)
  if (!picked) return <Empty>Select a scenario to see the data and assumptions behind its assessment.</Empty>
  return <AssessmentFor entries={entries} picked={picked} part="data" />
}

/** Science vs engineering: the landing that best satisfies both teams, searched around the picked plan. */
export function ScienceVsEngineeringBlock({ entries }: { entries: Entry[] }) {
  const picked = usePicked(entries)
  const sc: Scenario | null = useMemo(() => (picked ? toTeamScenario(picked.scenario) : null), [picked])
  if (!picked) return <Empty>Select a scenario to look for a science / engineering compromise around it.</Empty>
  return (
    <div>
      <p className="mb-3 max-w-2xl text-sm text-ink-3">
        Science wants to be near the shadowed crater with the ice; engineering wants steady sunlight and Earth contact. Choose the plan to search around,
        say what science needs, and weigh the two teams: the search returns the best balance, or what each side would have to give up.
      </p>
      <PlanPicker entries={entries} picked={picked} label="Plan to search around" />
      <div className="max-w-xl">
        <CompromisePanel base={sc} pickLabel="Add recommended plan to comparison"
          onPick={(s) => useCompareStore.getState().importScenarios([s], { origin: 'rescue', names: [`Compromise at ${s.site.name}`], replaceSelection: false })} />
      </div>
    </div>
  )
}
