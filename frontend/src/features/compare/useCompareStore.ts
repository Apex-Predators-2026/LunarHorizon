// Zustand store for the comparison workspace (Member 4).
//
// - Saved plans live in usePlansStore. Comparison labels, selection, weights and view settings
//   persist in sessionStorage for the current
//   browser session. Results are cached in memory by resultKey() and refetched only when a
//   scenario's inputs change.
// - Other modules push scenarios in with `sendToComparison()` (e.g. Mission Rescue alternatives).
// - The selected time is mirrored into the shared app store (siteId + timeUtc) so the 3D view
//   and other panels can follow the comparison cursor.
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

import rescueDemo from '../../../../backend/app/rescue/demo_scenario.json'
import { useAppStore } from '../../store'
import type { MissionRequirements, Scenario } from '../../types'
import { usePlansStore, type Plan } from '../plans/usePlansStore'
import { WEIGHT_PRESETS, axisOrigin, type Align, type Weights } from './analysis'
import { errorMessage, fetchSites, isUnreachable, postCompare } from './api'
import { MAX_COMPARED } from './palette'
import type { RescueContext } from './rescueFlow'
import {
  FALLBACK_SITES,
  DEFAULT_SPACECRAFT,
  duplicateShifted,
  fromTeamScenario,
  makeScenario,
  resultKey,
  selectionKey,
  siteOptionFromInfo,
  toTeamScenario,
  validateScenario,
  type SiteOption,
} from './scenario'
import type { ComparisonScenario, PairEvidence, RankingGroup, ResultState, ScenarioOrigin, SpacecraftConfig } from './types'

type Status = 'idle' | 'loading' | 'done' | 'error'
export type QuickComparison = 'locations' | 'dates' | 'durations' | 'battery' | 'recovery'

export interface CompareState {
  scenarios: ComparisonScenario[]
  selectedIds: string[] // scenarios in the comparison, max MAX_COMPARED, in display order
  activeId: string | null // plan followed by the 3D view
  baselineId: string | null // deltas are shown against this one
  allowDemo: boolean
  educational: boolean
  align: Align
  view: [number, number] | null // visible part of the shared time axis (hours); null = all
  cursor: number | null // selected moment on the shared axis (hours)
  weights: Weights
  traverseKm: number

  results: Record<string, ResultState> // by resultKey
  notes: string[]
  viabilitySource: string
  // Canonical ranking of the selected set. A ranking is a property of the whole set, so it is only valid
  // while rankingSetKey === selectionKey(...) of the current selection.
  rankingGroups: RankingGroup[]
  rankingMethod: string | null
  rankingPairs: PairEvidence[] // the engine's pairwise evidence for the same set
  /** The backend's mission-time policy for the same set (how a landing time becomes the evaluated interval). */
  timePolicy: string | null
  rankingSetKey: string | null
  /** Set when the selection was imported from Mission Rescue: roles of each imported scenario and what changed. */
  rescueContext: RescueContext | null
  setRescueContext: (ctx: RescueContext | null) => void
  sites: SiteOption[]
  sitesStatus: Status
  sitesError: string | null

  addScenario: (init?: Partial<ComparisonScenario>) => string
  updateScenario: (id: string, patch: Partial<ComparisonScenario>) => void
  /** Merge into the scenario's *current* requirements / spacecraft (safe for several quick edits in a row). */
  updateRequirements: (id: string, patch: Partial<MissionRequirements>) => void
  updateSpacecraft: (id: string, patch: Partial<SpacecraftConfig>) => void
  removeScenario: (id: string) => void
  duplicateScenario: (id: string, shiftDays?: number, options?: { select?: boolean }) => string | null
  toggleSelected: (id: string) => void
  setSelected: (ids: string[]) => void
  setActive: (id: string | null) => void
  setBaseline: (id: string | null) => void
  importScenarios: (list: Scenario[], opts?: ImportOptions) => string[]
  loadPreset: (kind: QuickComparison, opts?: { siteId?: string; landingUtc?: string }) => void

  setAllowDemo: (v: boolean) => void
  setEducational: (v: boolean) => void
  setAlign: (a: Align) => void
  setView: (v: [number, number] | null) => void
  setCursor: (x: number | null) => void
  setWeights: (w: Partial<Weights>) => void
  setTraverseKm: (km: number) => void

  loadSites: () => Promise<void>
  refresh: () => Promise<void>
}

export interface ImportOptions {
  origin?: ScenarioOrigin
  names?: string[]
  baselineIndex?: number // which of `list` becomes the baseline
  replaceSelection?: boolean
  notes?: string[]
}

const DEFAULT_DATE = '2027-01-15T00:00:00.000Z'

const defaultSite = (sites: SiteOption[]) =>
  FALLBACK_SITES.map((f) => sites.find((s) => s.id === f.id)).find((s) => !!s) ?? sites.find((s) => !s.isControl) ?? FALLBACK_SITES[0]

const freeSlot = (scenarios: ComparisonScenario[], selected: string[], forId: string) => {
  const used = new Set(scenarios.filter((s) => selected.includes(s.id) && s.id !== forId).map((s) => s.colorSlot))
  for (let i = 0; i < MAX_COMPARED; i++) if (!used.has(i)) return i
  return 0
}

/** Give every selected scenario a distinct colour slot, keeping existing slots where possible. */
function assignSlots(scenarios: ComparisonScenario[], selected: string[]): ComparisonScenario[] {
  const taken = new Set<number>()
  const keep = new Set<string>()
  for (const id of selected) {
    const s = scenarios.find((x) => x.id === id)
    if (s && !taken.has(s.colorSlot)) {
      taken.add(s.colorSlot)
      keep.add(id)
    }
  }
  return scenarios.map((s) => {
    if (!selected.includes(s.id) || keep.has(s.id)) return s
    let slot = 0
    while (taken.has(slot)) slot++
    taken.add(slot)
    return { ...s, colorSlot: slot }
  })
}

function savedPlan(s: ComparisonScenario): Plan {
  return { id: s.id, name: s.name, scenario: toTeamScenario(s), spacecraft: s.spacecraft, notes: s.notes, origin: s.origin }
}

function comparisonPlan(plan: Plan, scenarios: ComparisonScenario[]): ComparisonScenario {
  const current = scenarios.find((s) => s.id === plan.id)
  const metadata = current ?? fromTeamScenario(plan.scenario, scenarios.map((s) => s.label), plan.origin ?? 'user')
  return {
    ...metadata,
    ...plan.scenario,
    id: plan.id,
    name: plan.name,
    landing_utc: new Date(plan.scenario.landing_utc).toISOString(),
    spacecraft: plan.spacecraft ?? DEFAULT_SPACECRAFT,
    notes: plan.notes,
  }
}

function reconcilePlans(state: CompareState, plans: Plan[], previous?: Plan[]) {
  const removed = new Set((previous ?? state.scenarios).filter((p) => !plans.some((plan) => plan.id === p.id)).map((p) => p.id))
  let scenarios = removed.size ? state.scenarios.filter((s) => !removed.has(s.id)) : state.scenarios
  for (const plan of plans) {
    if (previous?.includes(plan)) continue
    const scenario = comparisonPlan(plan, scenarios)
    scenarios = scenarios.some((s) => s.id === plan.id)
      ? scenarios.map((s) => s.id === plan.id ? scenario : s)
      : [...scenarios, scenario]
  }
  const hasPlan = (id: string | null) => scenarios.some((s) => s.id === id)
  return {
    scenarios,
    selectedIds: state.selectedIds.filter(hasPlan),
    activeId: hasPlan(state.activeId) ? state.activeId : null,
    baselineId: hasPlan(state.baselineId) ? state.baselineId : null,
  }
}

let inflight: AbortController | null = null

export const useCompareStore = create<CompareState>()(
  persist(
    (set, get) => ({
      scenarios: [],
      selectedIds: [],
      activeId: null,
      baselineId: null,
      allowDemo: false,
      educational: false,
      align: 'met',
      view: null,
      cursor: null,
      weights: WEIGHT_PRESETS.balanced.weights,
      traverseKm: 15,
      results: {},
      notes: [],
      viabilitySource: '',
      rankingGroups: [],
      rankingMethod: null,
      rankingPairs: [],
      timePolicy: null,
      rankingSetKey: null,
      rescueContext: null,
      setRescueContext: (rescueContext) => set({ rescueContext }),
      sites: FALLBACK_SITES,
      sitesStatus: 'idle',
      sitesError: null,

      addScenario: (init) => {
        const { scenarios, selectedIds, sites } = get()
        // Default to a curated landing candidate (Peak Near Shackleton, Malapert Massif, Connecting Ridge), not
        // whatever happens to be first in the site list (which now also lists historic landings).
        const site = init?.site ?? defaultSite(sites)
        const sc = makeScenario({ landing_utc: DEFAULT_DATE, ...init, site }, scenarios.map((s) => s.label), init?.origin ?? 'user')
        const select = selectedIds.length < MAX_COMPARED
        sc.colorSlot = freeSlot(scenarios, selectedIds, sc.id)
        set({
          scenarios: [...scenarios, sc],
          selectedIds: select ? [...selectedIds, sc.id] : selectedIds,
          activeId: sc.id,
        })
        usePlansStore.getState().addPlans([savedPlan(sc)])
        return sc.id
      },

      updateScenario: (id, patch) => {
        const current = get().scenarios.find((s) => s.id === id)
        if (!current) return
        const next = { ...current, ...patch, id, label: current.label }
        const plan = savedPlan(next)
        usePlansStore.getState().update(id, plan.name, plan.scenario, { spacecraft: plan.spacecraft, notes: plan.notes })
        set({ scenarios: get().scenarios.map((s) => s.id === id ? next : s) })
      },
      updateRequirements: (id, patch) => {
        const current = get().scenarios.find((s) => s.id === id)
        if (current) get().updateScenario(id, { requirements: { ...current.requirements, ...patch } })
      },
      updateSpacecraft: (id, patch) => {
        const current = get().scenarios.find((s) => s.id === id)
        if (current) get().updateScenario(id, { spacecraft: { ...current.spacecraft, ...patch } })
      },

      removeScenario: (id) => {
        usePlansStore.getState().remove(id)
        const { scenarios, selectedIds, activeId, baselineId } = get()
        set({
          scenarios: scenarios.filter((s) => s.id !== id),
          selectedIds: selectedIds.filter((x) => x !== id),
          activeId: activeId === id ? null : activeId,
          baselineId: baselineId === id ? null : baselineId,
        })
      },

      duplicateScenario: (id, shiftDays = 0, { select: shouldSelect = true } = {}) => {
        const { scenarios, selectedIds } = get()
        const src = scenarios.find((s) => s.id === id)
        if (!src) return null
        const copy = duplicateShifted(src, shiftDays, scenarios.map((s) => s.label))
        const select = shouldSelect && selectedIds.length < MAX_COMPARED
        copy.colorSlot = freeSlot(scenarios, selectedIds, copy.id)
        set({
          scenarios: [...scenarios, copy],
          selectedIds: select ? [...selectedIds, copy.id] : selectedIds,
          activeId: shouldSelect ? copy.id : get().activeId,
        })
        usePlansStore.getState().addPlans([savedPlan(copy)])
        return copy.id
      },

      toggleSelected: (id) => {
        const { selectedIds } = get()
        if (selectedIds.includes(id)) return get().setSelected(selectedIds.filter((x) => x !== id))
        if (selectedIds.length >= MAX_COMPARED) return
        get().setSelected([...selectedIds, id])
      },

      setSelected: (ids) => {
        const { scenarios, baselineId } = get()
        const valid = ids.filter((id) => scenarios.some((s) => s.id === id)).slice(0, MAX_COMPARED)
        set({
          selectedIds: valid,
          scenarios: assignSlots(scenarios, valid),
          baselineId: baselineId && valid.includes(baselineId) ? baselineId : null,
        })
      },

      setActive: (activeId) => {
        set({ activeId })
        get().setCursor(get().cursor) // re-sync the shared store to the newly followed scenario
      },
      setBaseline: (baselineId) => set({ baselineId }),

      importScenarios: (list, opts = {}) => {
        const { scenarios } = get()
        const labels = scenarios.map((s) => s.label)
        const added = list.map((sc, i) => {
          const s = fromTeamScenario(sc, labels, opts.origin ?? 'external', {
            name: opts.names?.[i],
            notes: opts.notes?.[i],
          })
          labels.push(s.label)
          return s
        })
        const all = [...scenarios, ...added]
        const ids = added.map((s) => s.id)
        set({ scenarios: all, view: null, cursor: null })
        usePlansStore.getState().addPlans(added.map(savedPlan))
        const keep = opts.replaceSelection === false ? get().selectedIds : []
        get().setSelected([...keep, ...ids])
        if (opts.baselineIndex !== undefined && ids[opts.baselineIndex]) set({ baselineId: ids[opts.baselineIndex] })
        return ids
      },

      loadPreset: (kind, opts = {}) => {
        const { sites } = get()
        const preset = { origin: 'preset', baselineIndex: 0 } as const
        const original = rescueDemo.original
        const delayed = { ...original, landing_utc: rescueDemo.verified.delayed.landing_utc }
        const alternative = rescueDemo.verified.first_alternative
        const landing = opts.landingUtc ?? DEFAULT_DATE
        if (kind === 'locations') {
          // The three curated south-pole candidates (with real data), whatever else the site list contains.
          const curated = FALLBACK_SITES.map((f) => sites.find((s) => s.id === f.id) ?? f)
          const picks = curated.slice(0, 3)
          get().importScenarios(
            picks.map((site) => ({ ...toTeamScenario(makeScenario({ site, landing_utc: landing }, [])) })),
            preset,
          )
        } else if (kind === 'dates') {
          const site = sites.find((s) => s.id === opts.siteId) ?? sites.find((s) => s.id === 'malapert-massif') ?? FALLBACK_SITES[1]
          const base = makeScenario({ site, landing_utc: landing }, [])
          get().importScenarios(
            [0, 14, 28].map((d) => toTeamScenario(duplicateShifted(base, d, []))),
            preset,
          )
        } else if (kind === 'durations') {
          get().importScenarios([3, 7, 14].map((duration_days) => ({ ...original, duration_days })), preset)
        } else if (kind === 'battery') {
          const limits = [40, original.requirements.battery_hours, 72]
          get().importScenarios(
            limits.map((battery_hours) => ({ ...delayed, requirements: { ...delayed.requirements, battery_hours } })),
            { ...preset, baselineIndex: 1, names: limits.map((hours) => `${hours} h battery limit`) },
          )
        } else {
          const site = FALLBACK_SITES.find((s) => s.id === alternative.site_id)!
          get().importScenarios(
            [original, delayed, { ...original, site, landing_utc: alternative.landing_utc }],
            { ...preset, baselineIndex: 1, names: ['Original landing', 'After 5-day delay', 'Mission Rescue alternative'] },
          )
        }
      },

      setAllowDemo: (allowDemo) => set({ allowDemo }),
      setEducational: (educational) => set({ educational }),
      setAlign: (align) => set({ align, view: null, cursor: null }),
      setView: (view) => set({ view }),
      setCursor: (cursor) => {
        set({ cursor })
        if (cursor === null) return
        // Mirror into the shared app store for the 3D view (Andrew) and other panels.
        const { scenarios, selectedIds, activeId, align, results, allowDemo } = get()
        const selected = scenarios.filter((s) => selectedIds.includes(s.id))
        const follow = selected.find((s) => s.id === activeId) ?? selected[0]
        if (!follow) return
        // The cursor sits on the shared axis, whose origin is the evaluated landing (missionTime.ts), exactly as
        // the dashboard lays it out; using the requested landing would shift the 3D view (00:15 vs 00:00 data).
        const item = (s: ComparisonScenario) => ({ scenario: s, state: results[resultKey(s, allowDemo)] })
        const origin = align === 'utc' ? axisOrigin(selected.map(item)) : axisOrigin([item(follow)])
        const t = new Date(origin + cursor * 3_600_000)
        if (Number.isNaN(t.getTime())) return
        const app = useAppStore.getState()
        if (!follow.site.id.startsWith('custom:')) app.setSite(follow.site.id)
        app.setTime(t.toISOString())
      },
      setWeights: (w) => set({ weights: { ...get().weights, ...w } }),
      setTraverseKm: (traverseKm) => set({ traverseKm }),

      loadSites: async () => {
        if (get().sitesStatus === 'loading') return
        set({ sitesStatus: 'loading', sitesError: null })
        try {
          const list = await fetchSites()
          set({ sites: list.map(siteOptionFromInfo), sitesStatus: 'done' })
        } catch (e) {
          set({ sitesStatus: 'error', sitesError: errorMessage(e), sites: FALLBACK_SITES })
        }
      },

      refresh: async () => {
        const { scenarios, selectedIds, allowDemo, results, rankingSetKey } = get()
        const selected = selectedIds.map((id) => scenarios.find((s) => s.id === id)).filter((s): s is ComparisonScenario => !!s)
        const valid: ComparisonScenario[] = []
        const next = { ...results }
        for (const s of selected) {
          const key = resultKey(s, allowDemo)
          const problems = validateScenario(s)
          if (problems.length) next[key] = { state: 'error', message: problems.join(' ') }
          else valid.push(s)
        }
        const setKey = selectionKey(valid, allowDemo)
        const allDone = valid.every((s) => next[resultKey(s, allowDemo)]?.state === 'done')
        if (setKey === rankingSetKey && allDone) {
          set({ results: next })
          return
        }
        // Scenarios without any result yet show "loading"; existing results stay visible while the set is re-ranked.
        for (const s of valid) {
          const key = resultKey(s, allowDemo)
          if (!next[key] || next[key].state === 'error') next[key] = { state: 'loading' }
        }
        set({ results: next })
        if (!valid.length) {
          set({ rankingGroups: [], rankingMethod: null, rankingSetKey: setKey })
          return
        }
        inflight?.abort()
        const ctrl = new AbortController()
        inflight = ctrl
        try {
          // The whole selected set goes in one request: the canonical ranking compares the scenarios together.
          const res = await postCompare(
            {
              scenarios: valid.map((s) => ({ key: resultKey(s, allowDemo), scenario: toTeamScenario(s), spacecraft: s.spacecraft })),
              allow_demo_data: allowDemo,
            },
            ctrl.signal,
          )
          const done = { ...get().results }
          for (const r of res.results) done[r.key] = { state: 'done', result: r }
          set({
            results: done, notes: res.notes, viabilitySource: res.viability_source,
            rankingGroups: res.ranking_groups ?? [], rankingMethod: res.ranking_method ?? null, rankingSetKey: setKey,
            rankingPairs: res.pairwise ?? [], timePolicy: res.time_policy ?? null,
          })
        } catch (e) {
          if (ctrl.signal.aborted) return
          const failed = { ...get().results }
          const msg = errorMessage(e)
          // Only a request that never reached the backend is "unavailable"; an error the backend sent back is shown
          // as that error (it is running, it could not evaluate these plans).
          const offline = isUnreachable(e)
          for (const s of valid) {
            failed[resultKey(s, allowDemo)] = {
              state: 'error',
              message: offline
                ? `Backend unavailable (${msg}). No scientific data is shown for this plan.`
                : `The backend could not evaluate this plan (${msg}). No scientific data is shown for it.`,
            }
          }
          set({ results: failed, rankingGroups: [], rankingMethod: null, rankingSetKey: null })
        } finally {
          if (inflight === ctrl) inflight = null
        }
      },
    }),
    {
      name: 'lunar-compare-workspace',
      version: 2,
      storage: createJSONStorage(() => sessionStorage),
      migrate: (persisted) => {
        const workspace = persisted as Pick<CompareState, 'scenarios' | 'selectedIds' | 'activeId' | 'baselineId' | 'rescueContext'>
        const store = usePlansStore.getState()
        const ids = new Map<string, string>()
        const migrated = new Map<string, ComparisonScenario>()
        const additions: Plan[] = []
        for (const scenario of workspace.scenarios ?? []) {
          // Older Planner-to-Comparison transfers copied all of these fields without carrying the saved ID.
          const match = store.plans.find((plan) => plan.id === scenario.id || (
            plan.name === scenario.name &&
            resultKey(comparisonPlan(plan, []), false) === resultKey(scenario, false)
          ))
          const id = match?.id ?? scenario.id
          ids.set(scenario.id, id)
          if (!migrated.has(id)) migrated.set(id, { ...scenario, id })
          if (!match) additions.push(savedPlan(scenario))
        }
        store.addPlans(additions)
        const remap = (id: string | null) => id ? ids.get(id) ?? id : null
        return {
          ...workspace,
          scenarios: [...migrated.values()],
          selectedIds: [...new Set((workspace.selectedIds ?? []).map((id) => ids.get(id) ?? id))],
          activeId: remap(workspace.activeId),
          baselineId: remap(workspace.baselineId),
          rescueContext: workspace.rescueContext && {
            ...workspace.rescueContext,
            roles: Object.fromEntries(Object.entries(workspace.rescueContext.roles).map(([id, role]) => [ids.get(id) ?? id, role])),
          },
        }
      },
      partialize: (s) => ({
        scenarios: s.scenarios, selectedIds: s.selectedIds, activeId: s.activeId, baselineId: s.baselineId,
        allowDemo: s.allowDemo, educational: s.educational, align: s.align, weights: s.weights, traverseKm: s.traverseKm,
        rescueContext: s.rescueContext,
      }),
    },
  ),
)

useCompareStore.setState(reconcilePlans(useCompareStore.getState(), usePlansStore.getState().plans))
usePlansStore.subscribe((state, previous) => {
  if (state.plans !== previous.plans) {
    useCompareStore.setState(reconcilePlans(useCompareStore.getState(), state.plans, previous.plans))
  }
})

export function selectSavedPlans(ids: string[]) {
  const comparison = useCompareStore.getState()
  comparison.setSelected(ids)
  comparison.setBaseline(useCompareStore.getState().selectedIds[0] ?? null)
  comparison.setView(null)
  comparison.setCursor(null)
}

/**
 * Integration point for other modules (e.g. Mission Rescue): put team Scenarios into the
 * comparison workspace and select them. The first one becomes the baseline unless told otherwise.
 *
 *   sendToComparison([rescue.changed.scenario, ...rescue.alternatives.slice(0, 3).map(a => a.scenario)],
 *                    { origin: 'rescue', names: ['Delayed plan', 'Alt 1', 'Alt 2', 'Alt 3'] })
 */
export function sendToComparison(list: Scenario[], opts: ImportOptions = {}): string[] {
  return useCompareStore.getState().importScenarios(list.slice(0, MAX_COMPARED), { baselineIndex: 0, ...opts })
}
