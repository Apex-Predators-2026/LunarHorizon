// The comparison's scenario area, compact: the selected scenarios as a strip (identity, where/when, Edit), with
// the full scenario manager and the view options behind explicit disclosures. It sits above the three views, so
// the selection is always visible and editable whichever view is open.
import { SelectField } from '../../ui/MdFields'
import { fmtUtc } from '../rescue/format'
import { Disclosure, useReveal } from './disclosure'
import { MAX_COMPARED } from './palette'
import { ScenarioManager } from './ScenarioManager'
import { Icon, ScenarioChip, btnQuiet } from './ui'
import { useCompareStore } from './useCompareStore'

/** An M3 switch row, the same markup as the planner's layer switches (md-row + md-switch). */
function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} data-tip={hint} data-no-ripple
      onClick={() => onChange(!checked)}
      className="md-row flex h-10 items-center gap-3 rounded-full px-3 text-sm text-ink-2">
      <span className="md-switch" aria-hidden="true">
        <span className="md-switch-handle"><Icon name="check" size={16} /></span>
      </span>
      {label}
    </button>
  )
}

export function ScenarioStrip() {
  const scenarios = useCompareStore((s) => s.scenarios)
  const selectedIds = useCompareStore((s) => s.selectedIds)
  const baselineId = useCompareStore((s) => s.baselineId)
  const align = useCompareStore((s) => s.align)
  const educational = useCompareStore((s) => s.educational)
  const allowDemo = useCompareStore((s) => s.allowDemo)
  const { setActive, setAlign, setEducational, setAllowDemo } = useCompareStore.getState()
  const reveal = useReveal((s) => s.reveal)

  const selected = selectedIds.map((id) => scenarios.find((s) => s.id === id)).filter((s): s is NonNullable<typeof s> => !!s)

  return (
    <section id="cmp-scenarios" aria-labelledby="cmp-scenarios-h" className="cmp-section scroll-mt-16 !p-4">
      <div data-tour="compare-select">
        <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 id="cmp-scenarios-h" className="text-lg font-medium text-ink">Plans</h2>
          <span className="text-xs text-ink-3" aria-live="polite">
            Comparing <strong className="text-ink-2">{selected.length}</strong> of {scenarios.length} saved (max {MAX_COMPARED})
          </span>
        </div>
        {selected.length === 0 ? (
          <p className="text-sm text-ink-3">No plan is selected. Open “Manage plans” to select plans or choose a quick comparison.</p>
        ) : (
          <ul className="flex flex-wrap gap-2" aria-label="Plans being compared">
            {selected.map((s) => (
              <li key={s.id} className="flex min-w-0 items-center gap-2 rounded-xl border border-line bg-inset py-1 pl-3 pr-1">
                <ScenarioChip s={s} />
                <span className="min-w-0">
                  <span className="block max-w-[260px] truncate text-sm font-medium text-ink">
                    {s.name}
                    {baselineId === s.id && <span className="ml-1.5 rounded bg-cyan-900/70 px-1 text-[11px] font-normal text-cyan-200">baseline</span>}
                  </span>
                  {/* Default names already say site, date and length; only a renamed scenario needs the line. */}
                  {!s.name.includes(s.site.name) && (
                    <span className="block max-w-[260px] truncate text-[11px] text-ink-3">
                      {s.site.name} · {fmtUtc(s.landing_utc)} · {s.duration_days} d
                    </span>
                  )}
                </span>
                <button type="button" className={btnQuiet} aria-label={`Edit plan ${s.label}`}
                  onClick={() => {
                    setActive(s.id)
                    reveal('cmp-scenarios-manage')
                  }}>
                  Edit
                </button>
              </li>
            ))}
          </ul>
        )}
        {selected.length === 1 && <p className="mt-2 text-xs text-amber-300">Select at least one more plan to compare.</p>}
      </div>

      <Disclosure id="cmp-scenarios-manage" className="mt-2" defaultOpen={selected.length < 2} title="Manage plans"
        summary={`${scenarios.length} saved · add, duplicate, shift a date, edit, import`}>
        <ScenarioManager />
      </Disclosure>
      <Disclosure id="cmp-view-options" title="View options"
        summary={`${align === 'met' ? 'Mission elapsed time' : 'Calendar date'} · educational ${educational ? 'on' : 'off'} · demonstration data ${allowDemo ? 'allowed' : 'off'}`}>
        <div className="flex flex-wrap items-center gap-2">
          <SelectField label="Align timelines by" value={align} fieldClassName="w-60"
            tip="Line the plans up by time since landing, or by calendar date"
            onChange={(e) => setAlign(e.target.value as 'met' | 'utc')}>
            <option value="met">Mission elapsed time</option>
            <option value="utc">Calendar date (UTC)</option>
          </SelectField>
          <Toggle checked={educational} onChange={setEducational} label="Educational mode" hint="Show short explanations of the science behind each panel" />
          <Toggle checked={allowDemo} onChange={setAllowDemo} label="Allow demonstration data"
            hint="Where no real Horizons + LOLA data exists (other dates/sites), show a clearly labelled synthetic illustration instead of nothing" />
        </div>
      </Disclosure>
    </section>
  )
}
