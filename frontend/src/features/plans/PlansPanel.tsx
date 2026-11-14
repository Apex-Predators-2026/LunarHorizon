// Plans in the Mission Planner sidebar: a list of saved plans (run / compare / edit / delete) and an M3
// floating action button that opens the "New plan" dialog.
// https://m3.material.io/components/floating-action-button
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

import { useAppStore } from '../../store'
import { DEFAULT_REQUIREMENTS, type MissionRequirements, type Scenario } from '../../types'
import { InteractiveGrainGradient } from '../../ui/InteractiveGrainGradient'
import { DateField, SelectField, TextField } from '../../ui/MdFields'
import { DatePopup } from '../../viz/DatePopup'
import { showSnackbar } from '../../viz/snackbarStore'
import { sendToComparison } from '../compare'
import { fetchRescueCatalog } from '../rescue/api'
import { fmtUtc, fromUtcInput, toUtcInput } from '../rescue/format'
import { REQUIREMENT_FIELDS, REQUIREMENT_TIPS } from '../rescue/PlanForm'
import type { RescueCatalog } from '../rescue/types'
import { useRescueStore } from '../rescue/useRescueStore'
import { usePlanDialog, usePlansStore, type Plan } from './usePlansStore'

const MAX_COMPARE = 6
const PLUS_MASK = 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 60 60\'%3E%3Cpath d=\'M27 2h6v56h-6zM2 27h56v6H2z\'/%3E%3C/svg%3E")'

const ICON = {
  add: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
  play: 'M8 5v14l11-7z',
  edit: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z',
  del: 'M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
  compare: 'M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h5v2h2V1h-2v2zm0 15H5l5-6v6zm9-15h-5v2h5v13l-5-6v9h5a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z',
}
const Icon = ({ d, size = 20 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d={d} />
  </svg>
)

function PlanDialog({ plan, nextName, onClose }: { plan: Plan | null; nextName: string; onClose: () => void }) {
  const add = usePlansStore((s) => s.add)
  const update = usePlansStore((s) => s.update)
  const [catalog, setCatalog] = useState<RescueCatalog | null>(null)
  const [name, setName] = useState(plan?.name ?? nextName)
  const [siteId, setSiteId] = useState(plan?.scenario.site.id ?? '')
  const [landing, setLanding] = useState(toUtcInput(plan?.scenario.landing_utc ?? '2027-10-15T00:00:00Z'))
  const [duration, setDuration] = useState(plan?.scenario.duration_days ?? 7)
  const [req, setReq] = useState<MissionRequirements>(plan?.scenario.requirements ?? DEFAULT_REQUIREMENTS)
  const [calendar, setCalendar] = useState(false)
  const [closing, setClosing] = useState(false)
  const [loadError, setLoadError] = useState(false)

  useEffect(() => {
    const ctl = new AbortController()
    fetchRescueCatalog(ctl.signal)
      .then((c) => {
        setCatalog(c)
        const appSite = useAppStore.getState().siteId
        setSiteId((cur) => cur || (c.sites.find((s) => s.id === appSite) ?? c.sites[0])?.id || '')
      })
      .catch(() => !ctl.signal.aborted && setLoadError(true))
    return () => ctl.abort()
  }, [])

  const site = catalog?.sites.find((s) => s.id === siteId)
  const valid = !!site && name.trim().length > 0 && duration >= 1
  const close = () => setClosing(true)

  const save = (e: React.FormEvent) => {
    e.preventDefault()
    if (!site) return
    const scenario: Scenario = {
      site: { id: site.id, name: site.name, lat: site.lat, lon: site.lon },
      landing_utc: fromUtcInput(landing),
      duration_days: duration,
      requirements: req,
    }
    if (plan) update(plan.id, name.trim(), scenario)
    else add(name.trim(), scenario)
    showSnackbar(plan ? `Plan saved: ${name.trim()}` : `Plan created: ${name.trim()}`, 'success')
    close()
  }

  return createPortal(
    <div className={`fixed inset-0 z-[60] flex items-center justify-center p-4 ${closing ? 'md-snack-out' : ''}`} onAnimationEnd={(e) => closing && e.target === e.currentTarget && onClose()}>
      <div className="absolute inset-0 bg-black/40" onClick={close} aria-hidden />
      <form
        role="dialog"
        aria-modal="true"
        aria-label={plan ? 'Edit plan' : 'New plan'}
        onSubmit={save}
        className={`lp-light relative flex max-h-[90vh] w-[min(26rem,100%)] flex-col rounded-[28px] bg-opal-50 shadow-2xl shadow-black/50 ${closing ? '' : 'md-dialog-in'}`}
        style={{ ['--md-field-bg' as string]: '#f5f5f7' }}
      >
        <h2 className="px-6 pb-2 pt-6 text-2xl leading-8">{plan ? 'Edit plan' : 'New plan'}</h2>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-6 pb-2 text-xs">
          <TextField label="Plan name" tip="A name for this plan, shown on its card." value={name} onChange={(e) => setName(e.target.value)} maxLength={40} autoFocus />
          {loadError ? (
            <p role="alert" className="text-red-400">Could not load sites from the backend. Is it running?</p>
          ) : (
            <SelectField label="Landing site" tip="Where the lander touches down." value={siteId} onChange={(e) => setSiteId(e.target.value)} disabled={!catalog}>
              {catalog?.sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.has_real_data ? '' : ' (no real data: simulation only)'}
                </option>
              ))}
            </SelectField>
          )}
          <DateField label="Landing (UTC)" tip="Planned landing date and time (UTC). Opens a date picker." value={landing.replace('T', ' ')} expanded={calendar} onOpen={() => setCalendar((o) => !o)} />
          {calendar && (
            <DatePopup
              timeUtc={fromUtcInput(landing)}
              min="0000-01-01T00:00:00Z"
              max="9999-12-31T23:59:00Z"
              onPick={(iso) => setLanding(toUtcInput(iso))}
              onClose={() => setCalendar(false)}
            />
          )}
          <TextField label="Mission length (days)" tip="How many days the mission lasts after landing." type="number" min={1} max={365} step={1} value={duration} onChange={(e) => setDuration(Number(e.target.value))} />
          <details className="rounded-xl border border-slate-800 px-4 py-2">
            <summary className="flex min-h-10 cursor-pointer items-center text-slate-300" data-tip="What the spacecraft needs to survive and communicate. The plan is checked against these.">
              Spacecraft requirements
            </summary>
            <div className="grid grid-cols-1 gap-2 pb-2">
              {REQUIREMENT_FIELDS.map((f) => (
                <TextField
                  key={f.key}
                  label={f.label}
                  tip={REQUIREMENT_TIPS[f.key]}
                  type="number"
                  min={0}
                  max={f.percent ? 100 : undefined}
                  step={f.step}
                  value={f.percent ? Math.round(req[f.key] * 100) : req[f.key]}
                  onChange={(e) => {
                    const v = Number(e.target.value)
                    setReq({ ...req, [f.key]: f.percent ? v / 100 : v })
                  }}
                />
              ))}
            </div>
          </details>
        </div>
        <div className="flex justify-end gap-2 px-4 pb-4 pt-4">
          <button type="button" className="md-dp-text-button" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="md-dp-text-button" disabled={!valid}>
            {plan ? 'Save' : 'Create plan'}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  )
}

function PlanCard({ plan, onEdit, onRun }: { plan: Plan; onEdit: () => void; onRun: () => void }) {
  const active = usePlansStore((s) => s.activeId === plan.id)
  const compare = usePlansStore((s) => s.compareIds.includes(plan.id))
  const toggle = usePlansStore((s) => s.toggleCompare)
  const remove = usePlansStore((s) => s.remove)
  const sc = plan.scenario
  const iconBtn = 'flex h-10 w-10 items-center justify-center rounded-full text-slate-400'
  return (
    <li className={`md-reveal rounded-2xl border p-4 transition-colors ${active ? 'border-coral bg-coral/10' : 'border-slate-800 bg-white/60'}`} aria-label={`Plan ${plan.name}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-slate-100">{plan.name}</p>
          <p className="mt-1 text-xs text-slate-400">
            {sc.site.name} · {fmtUtc(sc.landing_utc)} · {sc.duration_days} d
          </p>
        </div>
        {active && <span className="shrink-0 rounded-full bg-coral px-2 py-0.5 text-[11px] font-semibold text-white">Running</span>}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <label className="flex items-center gap-3 text-xs text-slate-400" data-tip="Tick two or more plans, then press Compare to see them side by side.">
          <input type="checkbox" checked={compare} onChange={() => toggle(plan.id)} />
          Compare
        </label>
        <div className="flex">
          <button type="button" aria-label={`Edit ${plan.name}`} data-tip="Edit this plan" className={iconBtn} onClick={onEdit}>
            <Icon d={ICON.edit} />
          </button>
          <button
            type="button"
            aria-label={`Delete ${plan.name}`}
            data-tip="Delete this plan"
            className={iconBtn}
            onClick={() => {
              remove(plan.id)
              showSnackbar(`Plan deleted: ${plan.name}`)
            }}
          >
            <Icon d={ICON.del} />
          </button>
          <button type="button" data-tip="Run: show this plan on the map and use it for Mission rescue" className="md-btn ml-2 bg-sky-600 px-4 text-white hover:bg-sky-500" onClick={onRun}>
            <Icon d={ICON.play} size={18} />
            <span className="ml-1">Run</span>
          </button>
        </div>
      </div>
    </li>
  )
}

export function PlansPanel({ onCompare }: { onCompare: () => void }) {
  const plans = usePlansStore((s) => s.plans)
  const compareIds = usePlansStore((s) => s.compareIds)
  const setActive = usePlansStore((s) => s.setActive)
  const showDialog = usePlanDialog((d) => d.show)

  // Seed a default plan into the rescue store on first load if none is set yet, so Mission Playback
  // and Rescue/Compromise tools work immediately out of the box even before a plan card is saved.
  useEffect(() => {
    if (useRescueStore.getState().original) return
    const { plans: saved, activeId } = usePlansStore.getState()
    const active = saved.find((p) => p.id === activeId) ?? saved[0]
    if (active) {
      useRescueStore.getState().setOriginal(active.scenario)
      return
    }
    const ctl = new AbortController()
    fetchRescueCatalog(ctl.signal)
      .then((c) => {
        if (useRescueStore.getState().original) return
        const appSite = useAppStore.getState().siteId
        const chosen = c.sites.find((s) => s.id === appSite) ?? c.sites.find((s) => s.id === 'connecting-ridge') ?? c.sites[0]
        if (chosen) {
          useRescueStore.getState().setOriginal({
            site: { id: chosen.id, name: chosen.name, lat: chosen.lat, lon: chosen.lon },
            landing_utc: '2027-10-15T00:00:00.000Z',
            duration_days: 7,
            requirements: DEFAULT_REQUIREMENTS,
          })
        }
      })
      .catch(() => {})
    return () => ctl.abort()
  }, [])

  const run = (p: Plan) => {
    useRescueStore.getState().setOriginal(p.scenario)
    const app = useAppStore.getState()
    app.setSite(p.scenario.site.id)
    app.setTime(p.scenario.landing_utc)
    setActive(p.id)
    showSnackbar(`Running ${p.name}`, 'success')
  }
  const picked = plans.filter((p) => compareIds.includes(p.id)).slice(0, MAX_COMPARE)
  const compare = () => {
    sendToComparison(picked.map((p) => p.scenario), { origin: 'user', names: picked.map((p) => p.name), replaceSelection: true, baselineIndex: 0 })
    onCompare()
  }

  return (
    <section aria-label="Plans">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-100">Plans</h2>
        {picked.length >= 2 && (
          <button type="button" onClick={compare} data-tip="Open Scenario Comparison with the ticked plans" className="md-btn h-8 border border-coral px-3 text-coral">
            <Icon d={ICON.compare} size={18} />
            <span className="ml-1">Compare ({picked.length})</span>
          </button>
        )}
      </div>
      {plans.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-slate-700 p-4 text-xs text-slate-400">
          No plans yet. Press the + button on the map to create one, then run it here or tick plans to compare them.
        </p>
      ) : (
        <ul className="space-y-2">
          {plans.map((p) => (
            <PlanCard key={p.id} plan={p} onRun={() => run(p)} onEdit={() => showDialog(p)} />
          ))}
        </ul>
      )}

    </section>
  )
}

/** Renders the New / Edit plan dialog when it is open. Mount once. */
export function PlanDialogHost() {
  const open = usePlanDialog((d) => d.open)
  const plan = usePlanDialog((d) => d.plan)
  const hide = usePlanDialog((d) => d.hide)
  const count = usePlansStore((s) => s.plans.length)
  if (!open) return null
  return <PlanDialog key={plan?.id ?? 'new'} plan={plan} nextName={`Plan ${count + 1}`} onClose={hide} />
}

/**
 * The floating "new plan" button (M3 FAB, large). An off-white rounded square with a coral gradient plus.
 * https://m3.material.io/components/floating-action-button
 */
export function PlanFab() {
  const show = usePlanDialog((d) => d.show)
  return (
    <button
      type="button"
      aria-label="New plan"
      data-tip="New plan: create a mission plan, then run it from the sidebar or compare it with others"
      onClick={() => show(null)}
      className="md-pop-fab flex h-[clamp(72px,8.7vw,125px)] w-[clamp(72px,8.7vw,125px)] items-center justify-center rounded-[20%] bg-opal-50 text-coral shadow-lg shadow-black/40"
    >
      {/* The plus is cut out of the mango mesh. */}
      <span aria-hidden className="block h-[48%] w-[48%]" style={{ WebkitMaskImage: PLUS_MASK, maskImage: PLUS_MASK, WebkitMaskSize: '100% 100%', maskSize: '100% 100%' }}>
        <InteractiveGrainGradient className="h-full w-full" />
      </span>
    </button>
  )
}
