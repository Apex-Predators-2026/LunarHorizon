// Section 1: saved scenarios: add, duplicate (+ shift date), edit, remove, pick 2–4 to compare.
import { useId, useRef, useState } from 'react'

import { routeHash } from '../../appRoute'
import { PlanActionButton, PlanCardHeading, PlanCardLayout } from '../plans/PlanCardLayout'
import { editSavedPlan } from '../plans/usePlansStore'
import { MAX_COMPARED } from './palette'
import { RescueImport } from './RescueImport'
import { fmtDate, shiftIso } from './scenario'
import type { ComparisonScenario } from './types'
import { ScenarioChip, btn, btnPrimary, btnQuiet, input } from './ui'
import { useCompareStore, type QuickComparison } from './useCompareStore'

const QUICK_COMPARISONS: { id: QuickComparison; label: string; description: string }[] = [
  { id: 'locations', label: 'Same date, 3 sites', description: 'Compare sunlight and Earth contact at Peak Near Shackleton, Malapert Massif, and Connecting Ridge.' },
  { id: 'dates', label: 'Same site, 3 dates', description: 'See how landing on Jan 15, Jan 29, or Feb 12, 2027 changes conditions at Malapert Massif.' },
  { id: 'durations', label: 'Same landing, 3 mission lengths', description: 'See what happens to power and Earth contact over 3, 7, and 14 days at Connecting Ridge.' },
  { id: 'battery', label: 'Same landing, 3 battery limits', description: 'Compare 40, 50, and 72 hours of battery endurance against the same stretch of darkness.' },
  { id: 'recovery', label: 'Launch delay and recovery', description: 'Compare the original Connecting Ridge landing, a five-day delay, and the Mission Rescue alternative at Malapert Massif.' },
]

function QuickComparisonMenu() {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  const loadPreset = useCompareStore((s) => s.loadPreset)

  const close = () => {
    setOpen(false)
    trigger.current?.focus()
  }

  return (
    <div className="sm:relative" onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
    }}>
      <button ref={trigger} type="button" className={btn} aria-haspopup="menu" aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        data-tip="Load example plans for a side-by-side comparison."
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setOpen(true)
          }
        }}>
        Add quick comparison <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div id={menuId} role="menu" aria-label="Quick comparisons"
          className="md-menu absolute inset-x-0 top-full z-50 mt-1 max-h-[min(24rem,55vh)] !origin-top-left overflow-y-auto rounded-lg border border-line bg-opal-50 py-2 shadow-xl sm:right-auto sm:w-72"
          onKeyDown={(event) => {
            const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
            const index = items.indexOf(document.activeElement as HTMLButtonElement)
            switch (event.key) {
              case 'Escape': event.stopPropagation(); close(); break
              case 'ArrowDown': items[(index + 1) % items.length]?.focus(); break
              case 'ArrowUp': items[(index - 1 + items.length) % items.length]?.focus(); break
              case 'Home': items[0]?.focus(); break
              case 'End': items.at(-1)?.focus(); break
              default: return
            }
            event.preventDefault()
          }}>
          {QUICK_COMPARISONS.map(({ id, label, description }, index) => (
            <button key={id} type="button" role="menuitem" tabIndex={-1} autoFocus={index === 0}
              title={description}
              className="block w-full px-3 py-2 text-left hover:bg-inset focus-visible:bg-inset"
              onClick={() => {
                loadPreset(id)
                close()
              }}>
              <span className="block text-sm font-medium text-ink">{label}</span>
              <span className="block text-xs text-ink-3">{description}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

const ORIGIN_LABEL: Record<ComparisonScenario['origin'], string> = {
  user: 'custom', duplicate: 'copy', preset: 'preset', rescue: 'from rescue', external: 'imported',
}

function ShiftMenu({ s, onDone }: { s: ComparisonScenario; onDone: () => void }) {
  const duplicate = useCompareStore((st) => st.duplicateScenario)
  const [custom, setCustom] = useState(s.landing_utc.slice(0, 10))
  const go = (days: number) => {
    duplicate(s.id, days)
    onDone()
  }
  const customDays = (new Date(`${custom}T${s.landing_utc.slice(11, 19) || '00:00:00'}Z`).getTime() - new Date(s.landing_utc).getTime()) / 86_400_000
  return (
    <div role="menu" aria-label={`Duplicate ${s.label} and shift date`}
      className="absolute right-0 top-full z-30 mt-1 w-60 rounded-lg border border-line-strong bg-surface p-2 shadow-md">
      <div className="mb-1.5 text-[11px] text-slate-400">Duplicate {s.label} and shift landing by</div>
      <div className="grid grid-cols-4 gap-1">
        {[1, 7, 14, 30].map((d) => (
          <button key={d} role="menuitem" type="button" className={btn} onClick={() => go(d)}>+{d} d</button>
        ))}
        {[-1, -7, -14, -30].map((d) => (
          <button key={d} role="menuitem" type="button" className={btn} onClick={() => go(d)}>{d} d</button>
        ))}
      </div>
      <label className="mt-2 block text-[11px] text-slate-400">
        Custom landing date (UTC)
        <div className="mt-1 flex gap-1">
          <input type="date" value={custom} onChange={(e) => setCustom(e.target.value)} className={input} />
          <button type="button" className={btnPrimary} disabled={!Number.isFinite(customDays)} onClick={() => go(customDays)}>
            Add
          </button>
        </div>
      </label>
      {Number.isFinite(customDays) && customDays !== 0 && (
        <p className="mt-1 text-[11px] text-slate-500">
          {customDays > 0 ? '+' : ''}{customDays.toFixed(customDays % 1 ? 2 : 0)} days → {fmtDate(shiftIso(s.landing_utc, customDays))}
        </p>
      )}
    </div>
  )
}

function ScenarioRow({ s }: { s: ComparisonScenario }) {
  const st = useCompareStore()
  const [menu, setMenu] = useState(false)
  const selected = st.selectedIds.includes(s.id)
  const full = !selected && st.selectedIds.length >= MAX_COMPARED
  const active = st.activeId === s.id
  return (
    <PlanCardLayout name={s.name} active={active}>
      <div className="flex items-start justify-between gap-2">
        <PlanCardHeading name={s.name} scenario={s} />
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          {selected ? <ScenarioChip s={s} /> : <span className="grid h-5 min-w-5 place-items-center rounded bg-slate-700 px-1 text-xs font-medium text-slate-300">{s.label}</span>}
          <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[11px] text-slate-300">{ORIGIN_LABEL[s.origin]}</span>
          {st.baselineId === s.id && <span className="rounded-full bg-cyan-900/70 px-2 py-0.5 text-[11px] text-cyan-200">Baseline</span>}
        </div>
      </div>
      <div className="plan-card-actions mt-2 flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-3 text-xs text-slate-400" title={full ? `At most ${MAX_COMPARED} plans can be compared at once` : ''}>
          <input type="checkbox" checked={selected} disabled={full} onChange={() => st.toggleSelected(s.id)}
            aria-label={`Compare plan ${s.label}`} />
          Compare
        </label>
        <div className="flex flex-wrap gap-1">
          <div className="relative">
            <button type="button" className={btnQuiet} aria-expanded={menu} aria-haspopup="menu" onClick={() => setMenu(!menu)}>
              Duplicate &amp; shift date ▾
            </button>
            {menu && <ShiftMenu s={s} onDone={() => setMenu(false)} />}
          </div>
          <button type="button" className={btnQuiet} disabled={!selected} aria-pressed={st.baselineId === s.id}
            title="Show every other plan’s metrics as better/worse than this one"
            onClick={() => st.setBaseline(st.baselineId === s.id ? null : s.id)}>
            {st.baselineId === s.id ? 'Unset baseline' : 'Set baseline'}
          </button>
          <div className="flex">
            <PlanActionButton action="edit" label={`Edit ${s.name}`} tip="Edit this plan" onClick={() => editSavedPlan(s.id)} />
            <PlanActionButton action="duplicate" label={`Duplicate ${s.name}`} tip="Duplicate this plan" onClick={() => st.duplicateScenario(s.id)} />
            <PlanActionButton action="remove" label={`Delete ${s.name}`} tip="Delete this plan from both views" onClick={() => st.removeScenario(s.id)} />
          </div>
        </div>
      </div>
    </PlanCardLayout>
  )
}

export function ScenarioManager() {
  const scenarios = useCompareStore((s) => s.scenarios)
  const selectedIds = useCompareStore((s) => s.selectedIds)
  const setSelected = useCompareStore((s) => s.setSelected)

  return (
    <div className="space-y-3">
      <div className="relative flex flex-wrap items-center gap-2">
        <a className={btnPrimary} href={routeHash('planner')}>+ Add plan</a>
        <QuickComparisonMenu />
        <span className="ml-auto text-xs text-slate-400" aria-live="polite">
          Comparing <strong className="text-slate-200">{selectedIds.length}</strong> of {scenarios.length} saved (max {MAX_COMPARED})
          {selectedIds.length > 0 && (
            <button type="button" className="ml-2 text-cyan-400 hover:underline" onClick={() => setSelected([])}>clear</button>
          )}
        </span>
      </div>
      {scenarios.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-700 p-4 text-sm text-slate-400">
          Create a plan in Mission Planner or choose a preset from “Add quick comparison.”
        </p>
      ) : (
        <ul className="space-y-1.5">
          {scenarios.map((s) => <ScenarioRow key={s.id} s={s} />)}
        </ul>
      )}
      {selectedIds.length === 1 && (
        <p className="text-xs text-amber-300">Select at least one more plan to compare.</p>
      )}
      <RescueImport />
    </div>
  )
}
