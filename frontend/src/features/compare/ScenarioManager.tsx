// Section 1: saved scenarios — add, duplicate (+ shift date), edit, remove, pick 2–4 to compare.
import { useState } from 'react'

import { fmtUtc } from '../rescue/format'
import { MAX_COMPARED } from './palette'
import { RescueImport } from './RescueImport'
import { ScenarioEditor } from './ScenarioEditor'
import { fmtDate, shiftIso } from './scenario'
import type { ComparisonScenario } from './types'
import { ScenarioChip, btn, btnPrimary, input } from './ui'
import { useCompareStore } from './useCompareStore'

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
      className="absolute right-0 top-full z-30 mt-1 w-60 rounded-lg border border-[#2a3c63] bg-[#0a1427] p-2 shadow-xl">
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
    <li className={`relative rounded-lg border px-3 py-2 transition ${active ? 'border-cyan-600/80 bg-cyan-950/20' : selected ? 'border-[#2a3c63] bg-[#0e1a31]' : 'border-[#1a2743] bg-[#0a1324]'}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2" title={full ? `At most ${MAX_COMPARED} scenarios can be compared at once` : ''}>
          <input type="checkbox" checked={selected} disabled={full} onChange={() => st.toggleSelected(s.id)}
            className="h-4 w-4 accent-cyan-500" aria-label={`Compare scenario ${s.label}`} />
          {selected ? <ScenarioChip s={s} /> : <span className="grid h-5 min-w-5 place-items-center rounded bg-slate-700 px-1 text-xs font-bold text-slate-300">{s.label}</span>}
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium text-slate-100">{s.name}</span>
            <span className="block truncate text-[11px] text-slate-400">
              {s.site.lat.toFixed(3)}°, {s.site.lon.toFixed(3)}°E · {fmtUtc(s.landing_utc)} · {s.duration_days} d
              <span className="ml-1.5 rounded bg-slate-800 px-1 text-[10px] text-slate-400">{ORIGIN_LABEL[s.origin]}</span>
              {st.baselineId === s.id && <span className="ml-1.5 rounded bg-cyan-900/70 px-1 text-[10px] text-cyan-200">baseline</span>}
            </span>
          </span>
        </label>
        <div className="flex flex-wrap gap-1">
          <button type="button" className={btn} aria-pressed={active} onClick={() => st.setActive(active ? null : s.id)}>
            {active ? 'Close' : 'Edit'}
          </button>
          <button type="button" className={btn} onClick={() => st.duplicateScenario(s.id)}>Duplicate</button>
          <div className="relative">
            <button type="button" className={btn} aria-expanded={menu} aria-haspopup="menu" onClick={() => setMenu(!menu)}>
              Duplicate &amp; shift date ▾
            </button>
            {menu && <ShiftMenu s={s} onDone={() => setMenu(false)} />}
          </div>
          <button type="button" className={btn} disabled={!selected} aria-pressed={st.baselineId === s.id}
            title="Show every other scenario’s metrics as better/worse than this one"
            onClick={() => st.setBaseline(st.baselineId === s.id ? null : s.id)}>
            {st.baselineId === s.id ? 'Unset baseline' : 'Set baseline'}
          </button>
          <button type="button" className={`${btn} hover:border-red-700 hover:text-red-300`} onClick={() => st.removeScenario(s.id)}
            aria-label={`Remove scenario ${s.label}`}>
            Remove
          </button>
        </div>
      </div>
      {active && <ScenarioEditor s={s} />}
    </li>
  )
}

export function ScenarioManager() {
  const scenarios = useCompareStore((s) => s.scenarios)
  const selectedIds = useCompareStore((s) => s.selectedIds)
  const add = useCompareStore((s) => s.addScenario)
  const loadPreset = useCompareStore((s) => s.loadPreset)
  const setSelected = useCompareStore((s) => s.setSelected)

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={btnPrimary} onClick={() => add()}>+ Add scenario</button>
        <span className="mx-1 h-5 w-px bg-slate-700" aria-hidden="true" />
        <span className="text-xs text-slate-400">Quick comparisons:</span>
        <button type="button" className={btn} onClick={() => loadPreset('locations')}
          title="Peak Near Shackleton, Malapert Massif and Connecting Ridge on the same date">
          Same date, 3 sites
        </button>
        <button type="button" className={btn} onClick={() => loadPreset('dates')}
          title="Malapert Massif landing on Jan 15, Jan 29 and Feb 12 2027">
          Same site, 3 dates (14 d apart)
        </button>
        <span className="ml-auto text-xs text-slate-400" aria-live="polite">
          Comparing <strong className="text-slate-200">{selectedIds.length}</strong> of {scenarios.length} saved (max {MAX_COMPARED})
          {selectedIds.length > 0 && (
            <button type="button" className="ml-2 text-cyan-400 hover:underline" onClick={() => setSelected([])}>clear</button>
          )}
        </span>
      </div>
      {scenarios.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-700 p-4 text-sm text-slate-400">
          No scenarios yet. Add one, or start from a quick comparison above.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {scenarios.map((s) => <ScenarioRow key={s.id} s={s} />)}
        </ul>
      )}
      {selectedIds.length === 1 && (
        <p className="text-xs text-amber-300">Select at least one more scenario to compare.</p>
      )}
      <RescueImport />
    </div>
  )
}
