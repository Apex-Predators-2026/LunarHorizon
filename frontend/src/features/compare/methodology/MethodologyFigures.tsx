// Interactive figures for the Scenario Comparison methodology subpage. Each one illustrates a rule the
// engine applies, using the same formula (methodology.ts); none of them computes a mission result.
import { useId, useState, type ReactNode } from 'react'

import { STATE } from '../palette'
import { EligibilityBadge, Icon } from '../ui'
import {
  curvatureDropM, decide, DEFAULT_PANEL_THRESHOLD, horizonAngleDeg, PIPELINE, SUN_RADIUS_DEG, visibleSunFraction,
  type Comparison, type Verdict,
} from './methodology'

const fmt = (v: number, d = 1) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })

function Slider({ label, value, min, max, step, onChange, display }: {
  label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; display: string
}) {
  const id = useId()
  return (
    <div className="cmp-method-slider">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-xs font-medium text-ink-2">{label}</label>
        <output htmlFor={id} className="text-sm tabular-nums text-ink">{display}</output>
      </div>
      <input id={id} type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))} className="mt-1 w-full" />
    </div>
  )
}

export function Figure({ title, caption, children }: { title: string; caption: ReactNode; children: ReactNode }) {
  return (
    <figure className="cmp-method-figure">
      <figcaption className="mb-3">
        <span className="block text-sm font-medium text-ink">{title}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-ink-3">{caption}</span>
      </figcaption>
      {children}
    </figure>
  )
}

function Readout({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
      {items.map((it) => (
        <div key={it.label}>
          <dt className="text-[11px] uppercase tracking-wide text-ink-4">{it.label}</dt>
          <dd className="text-sm tabular-nums text-ink">{it.value}</dd>
        </div>
      ))}
    </dl>
  )
}

// ---- 1. Lunar curvature ------------------------------------------------------------------------

const RINGS = [
  { from: 0, to: 5, res: '5 m' },
  { from: 5, to: 45, res: '30 m' },
  { from: 45, to: 294, res: '200 m' },
]
const resolutionAt = (km: number) => (RINGS.find((r) => km <= r.to) ?? RINGS[RINGS.length - 1]).res

/** How far terrain appears above the horizon, with and without the Moon's curvature, against the Sun's sky band. */
export function CurvatureExplorer() {
  const [relief, setRelief] = useState(1000)
  const [dist, setDist] = useState(60)
  const W = 560, H = 246, L = 44, R = 12, T = 12, B = 62
  const xMax = 300, yMin = -5, yMax = 5
  const x = (km: number) => L + (km / xMax) * (W - L - R)
  const y = (deg: number) => T + ((yMax - deg) / (yMax - yMin)) * (H - T - B)
  const line = (curved: boolean) => {
    const pts: string[] = []
    for (let km = 0.5; km <= xMax; km += km < 10 ? 0.5 : 2) pts.push(`${x(km).toFixed(1)},${y(horizonAngleDeg(relief, km, curved)).toFixed(1)}`)
    return pts.join(' ')
  }
  const flat = horizonAngleDeg(relief, dist, false)
  const curved = horizonAngleDeg(relief, dist, true)
  const clip = useId().replace(/:/g, '')
  return (
    <Figure title="Why the Moon’s curvature matters at the pole"
      caption="A ridge’s angle above the horizon, seen from the landing site. The surface falls away by d²/2R (R = 1,737.4 km), so distant terrain sits lower than a flat map suggests. Near the pole the Sun stays within a couple of degrees of the horizon (shaded), so this decides whether a ridge casts a shadow.">
      <div className="-mx-1 overflow-x-auto px-1"><svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[460px]" role="img"
        aria-label={`Horizon angle of a ${relief} metre ridge: ${fmt(curved, 2)} degrees at ${dist} km with curvature, ${fmt(flat, 2)} degrees on a flat map.`}>
        <defs><clipPath id={clip}><rect x={L} y={T} width={W - L - R} height={H - T - B} /></clipPath></defs>
        <rect x={L} y={y(1.6)} width={W - L - R} height={y(-1.6) - y(1.6)} fill={STATE.sun} opacity={0.16} />
        <text x={W - R - 4} y={y(1.6) - 4} textAnchor="end" fontSize="10" fill={STATE.muted}>Sun’s sky height near the pole (about ±1.6°)</text>
        {[-4, -2, 0, 2, 4].map((d) => (
          <g key={d}>
            <line x1={L} x2={W - R} y1={y(d)} y2={y(d)} stroke={d === 0 ? STATE.axis : STATE.grid} strokeWidth={d === 0 ? 1 : 1} />
            <text x={L - 6} y={y(d) + 3} textAnchor="end" fontSize="10" fill={STATE.muted}>{d}°</text>
          </g>
        ))}
        {[0, 50, 100, 150, 200, 250, 300].map((km) => (
          <text key={km} x={x(km)} y={H - B + 14} textAnchor="middle" fontSize="10" fill={STATE.muted}>{km}</text>
        ))}
        <text x={(L + W - R) / 2} y={H - B + 27} textAnchor="middle" fontSize="10" fill={STATE.muted}>Distance from the site (km)</text>
        {RINGS.map((r, i) => (
          <g key={r.res}>
            <rect x={x(r.from)} y={H - 12} width={Math.max(2, x(Math.min(r.to, xMax)) - x(r.from) - 2)} height={6} rx={2}
              fill={STATE.ink} opacity={0.25 + 0.2 * i} />
            {i > 0 && <text x={(x(r.from) + x(r.to)) / 2} y={H - 15} textAnchor="middle" fontSize="9" fill={STATE.muted}>LOLA {r.res} grid</text>}
          </g>
        ))}
        <g clipPath={`url(#${clip})`}>
          <polyline points={line(false)} fill="none" stroke={STATE.muted} strokeWidth={2} strokeDasharray="5 4" />
          <polyline points={line(true)} fill="none" stroke={STATE.ink} strokeWidth={2} />
          <line x1={x(dist)} x2={x(dist)} y1={T} y2={H - B} stroke={STATE.axis} strokeWidth={1} strokeDasharray="2 3" />
          <circle cx={x(dist)} cy={y(curved)} r={5} fill={STATE.ink} stroke="#fff" strokeWidth={2} />
          <circle cx={x(dist)} cy={y(flat)} r={4} fill="#fff" stroke={STATE.muted} strokeWidth={2} />
        </g>
      </svg></div>
      <div className="mt-1 flex flex-wrap gap-4 text-xs text-ink-3" aria-hidden="true">
        <span className="inline-flex items-center gap-1.5"><svg width="22" height="6"><line x1="1" x2="21" y1="3" y2="3" stroke={STATE.ink} strokeWidth="2" /></svg>With curvature (the engine)</span>
        <span className="inline-flex items-center gap-1.5"><svg width="22" height="6"><line x1="1" x2="21" y1="3" y2="3" stroke={STATE.muted} strokeWidth="2" strokeDasharray="5 4" /></svg>Flat map</span>
      </div>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Slider label="Ridge height above the site" value={relief} min={0} max={4000} step={50} onChange={setRelief} display={`${relief.toLocaleString('en-US')} m`} />
        <Slider label="Distance to the ridge" value={dist} min={1} max={294} step={1} onChange={setDist} display={`${dist} km`} />
      </div>
      <div className="mt-4">
        <Readout items={[
          { label: 'Surface drop d²/2R', value: `${Math.round(curvatureDropM(dist)).toLocaleString('en-US')} m` },
          { label: 'Angle, flat map', value: `${fmt(flat, 2)}°` },
          { label: 'Angle, curved Moon', value: <strong className="font-medium">{fmt(curved, 2)}°</strong> },
          { label: 'Terrain read from', value: `LOLA ${resolutionAt(dist)} grid` },
          { label: 'Blocks a Sun at 1°?', value: curved >= 1 ? 'Yes' : 'No' },
        ]} />
      </div>
    </Figure>
  )
}

// ---- 2. Fractional solar disk ---------------------------------------------------------------

/** The Sun as a 0.53° disk, partly hidden by the horizon: the visible share and whether panels count as lit. */
export function SunDiskExplorer() {
  const [centre, setCentre] = useState(0.08)
  const [threshold, setThreshold] = useState(DEFAULT_PANEL_THRESHOLD)
  const f = visibleSunFraction(centre)
  const W = 300, H = 170, horizon = 110, r = 52
  const cy = horizon - (centre / SUN_RADIUS_DEG) * r
  const state = f <= 0 ? 'Dark: the whole disk is below the terrain'
    : f >= 1 ? 'Full sunlight: the whole disk is visible'
      : f >= threshold ? 'Partial sunlight, power-lit (at or above the panel threshold)'
        : 'Partial sunlight, but power-dark (below the panel threshold)'
  const lit = f > 0 && f >= threshold
  return (
    <Figure title="The Sun is a disk, not a point"
      caption="Near the pole the Sun often grazes a crater rim. The engine models it as a disk about 0.53° across and computes the share above the terrain, so a half-hidden Sun counts as half. Panels count as lit only when that share reaches the panel threshold (25% by default).">
      <div className="grid items-center gap-4 sm:grid-cols-[minmax(0,300px)_1fr]">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-[300px]" role="img"
          aria-label={`Solar disk with its centre ${fmt(centre, 2)} degrees above the horizon: ${Math.round(f * 100)} percent visible.`}>
          <rect x={0} y={0} width={W} height={horizon} fill="#eef1f5" rx={8} />
          <circle cx={W / 2} cy={cy} r={r} fill={STATE.sun} />
          <path d={`M0 ${horizon} L40 ${horizon - 6} L90 ${horizon - 2} L150 ${horizon} L210 ${horizon - 4} L260 ${horizon - 1} L${W} ${horizon - 5} L${W} ${H} L0 ${H} Z`}
            fill={STATE.dark} />
          <line x1={0} x2={W} y1={horizon} y2={horizon} stroke={STATE.axis} strokeDasharray="3 3" />
          <text x={8} y={horizon - 8} fontSize="10" fill={STATE.muted}>local horizon</text>
          <text x={W - 8} y={H - 10} textAnchor="end" fontSize="11" fill="#fff">{Math.round(f * 100)}% of the disk visible</text>
        </svg>
        <div className="space-y-4">
          <Slider label="Sun centre above the horizon" value={centre} min={-0.35} max={0.35} step={0.01} onChange={setCentre}
            display={`${centre > 0 ? '+' : ''}${fmt(centre, 2)}°`} />
          <Slider label="Panel threshold" value={threshold} min={0} max={1} step={0.05} onChange={setThreshold}
            display={`${Math.round(threshold * 100)}%`} />
          <p className="flex items-start gap-2 text-sm text-ink" aria-live="polite">
            <span className={`inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ${lit ? 'bg-[#fff3d6] text-[#7a5300]' : 'bg-[#2f3337] text-white'}`}>
              <Icon name={lit ? 'check' : 'close'} size={14} /> {lit ? 'Power-lit' : 'Power-dark'}
            </span>
            <span>{state}.</span>
          </p>
          <p className="text-xs leading-relaxed text-ink-3">
            visible = 1 − (acos u − u·√(1 − u²)) / π, with u = (centre − horizon) / radius, clipped to −1…1.
          </p>
        </div>
      </div>
    </Figure>
  )
}

// ---- 3. Requirement verdicts from bounds ------------------------------------------------------

const REQUIREMENTS: { id: string; label: string; comparison: Comparison; threshold: number; unit: string; max: number }[] = [
  { id: 'earth', label: 'Earth line of sight at least 40% of the mission', comparison: 'at_least', threshold: 40, unit: '%', max: 100 },
  { id: 'dark', label: 'Power darkness at most 50 h at a time (battery)', comparison: 'at_most', threshold: 50, unit: 'h', max: 150 },
]

const VERDICT_TEXT: Record<Verdict, (lo: string, hi: string, t: string, min: boolean) => string> = {
  PASS: (lo, hi, t, min) => min
    ? `Even the lowest value the data allows (${lo}) meets the minimum of ${t}, so the requirement is proven met.`
    : `Even the highest value the data allows (${hi}) stays within the limit of ${t}, so the requirement is proven met.`,
  FAIL: (lo, hi, t, min) => min
    ? `Even the highest value the data allows (${hi}) is below the minimum of ${t}, so the requirement is proven failed.`
    : `Even the lowest value the data allows (${lo}) exceeds the limit of ${t}, so the requirement is proven failed.`,
  UNKNOWN: (lo, hi, t) => `The true value could be anywhere from ${lo} to ${hi}, on both sides of ${t}. The data cannot decide, so the verdict is Unknown, never a guessed Pass or Fail.`,
}

/** The engine's three-valued requirement rule, on a number line. */
export function VerdictExplorer() {
  const [reqId, setReqId] = useState(REQUIREMENTS[0].id)
  const req = REQUIREMENTS.find((r) => r.id === reqId) ?? REQUIREMENTS[0]
  const [range, setRange] = useState<Record<string, [number, number]>>({ earth: [33, 52], dark: [30, 44] })
  const [lo, hi] = range[req.id]
  const set = (i: 0 | 1, v: number) => setRange((s) => {
    const next: [number, number] = [...s[req.id]] as [number, number]
    next[i] = v
    if (next[0] > next[1]) next[i === 0 ? 1 : 0] = v
    return { ...s, [req.id]: next }
  })
  const verdict = decide(req.comparison, lo, hi, req.threshold)
  const u = (v: number) => `${fmt(v, 0)}${req.unit === '%' ? '%' : ' h'}`
  const W = 560, H = 70, L = 12, R = 12
  const x = (v: number) => L + (v / req.max) * (W - L - R)
  const okFrom = req.comparison === 'at_least' ? req.threshold : 0
  const okTo = req.comparison === 'at_least' ? req.max : req.threshold
  return (
    <Figure title="Pass, Fail or Unknown: decided from what the data proves"
      caption="When some hours are missing, a measurement is known only as a range. A requirement passes only if every value in that range meets it, and fails only if none does. Move the range across the limit to see the verdict change.">
      <div role="radiogroup" aria-label="Requirement" className="mb-4 flex flex-wrap gap-2">
        {REQUIREMENTS.map((r) => (
          <button key={r.id} type="button" role="radio" aria-checked={r.id === req.id} onClick={() => setReqId(r.id)}
            className="cmp-btn-quiet">{r.label}</button>
        ))}
      </div>
      <div className="-mx-1 overflow-x-auto px-1"><svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[460px]" role="img"
        aria-label={`Measured range ${u(lo)} to ${u(hi)} against a ${req.comparison === 'at_least' ? 'minimum' : 'maximum'} of ${u(req.threshold)}: ${verdict}.`}>
        <rect x={x(okFrom)} y={14} width={x(okTo) - x(okFrom)} height={22} fill="#1f7a4d" opacity={0.1} />
        <text x={(x(okFrom) + x(okTo)) / 2} y={10} textAnchor="middle" fontSize="10" fill={STATE.muted}>meets the requirement</text>
        <line x1={L} x2={W - R} y1={25} y2={25} stroke={STATE.grid} strokeWidth={6} strokeLinecap="round" />
        <rect x={x(lo) - 1} y={19} width={Math.max(3, x(hi) - x(lo) + 2)} height={12} rx={6} fill={STATE.ink} />
        <line x1={x(req.threshold)} x2={x(req.threshold)} y1={10} y2={42} stroke="#b42e1a" strokeWidth={2} />
        <text x={x(req.threshold)} y={56} textAnchor="middle" fontSize="11" fill="#b42e1a">limit {u(req.threshold)}</text>
        <text x={L} y={56} fontSize="10" fill={STATE.muted}>0</text>
        <text x={W - R} y={56} textAnchor="end" fontSize="10" fill={STATE.muted}>{u(req.max)}</text>
      </svg></div>
      <div className="mt-2 grid gap-4 sm:grid-cols-2">
        <Slider label="Lowest value the data allows" value={lo} min={0} max={req.max} step={1} onChange={(v) => set(0, v)} display={u(lo)} />
        <Slider label="Highest value the data allows" value={hi} min={0} max={req.max} step={1} onChange={(v) => set(1, v)} display={u(hi)} />
      </div>
      <p className="mt-4 flex items-start gap-2 text-sm text-ink" aria-live="polite">
        <EligibilityBadge eligibility={verdict.toLowerCase() as 'pass' | 'fail' | 'unknown'} />
        <span>{VERDICT_TEXT[verdict](u(lo), u(hi), u(req.threshold), req.comparison === 'at_least')}</span>
      </p>
    </Figure>
  )
}

// ---- 4. Pipeline ------------------------------------------------------------------------------

/** The comparison pipeline as clickable steps; the chosen step says what goes in, what comes out and where. */
export function PipelineStepper() {
  const [active, setActive] = useState(PIPELINE[0].id)
  const step = PIPELINE.find((s) => s.id === active) ?? PIPELINE[0]
  const index = PIPELINE.indexOf(step)
  const base = useId().replace(/:/g, '')
  return (
    <div className="cmp-method-figure">
      <ol role="tablist" aria-label="Comparison pipeline" className="cmp-method-steps">
        {PIPELINE.map((s, i) => (
          <li key={s.id} role="presentation">
            <button type="button" role="tab" id={`${base}-${s.id}`} aria-selected={s.id === active} aria-controls={`${base}-panel`}
              onClick={() => setActive(s.id)} className="cmp-method-step">
              <span className="cmp-method-step-n" aria-hidden="true">{i + 1}</span>
              <span className="min-w-0">
                <span className="block text-sm font-medium text-ink">{s.title}</span>
                <span className="block text-xs text-ink-3">{s.short}</span>
              </span>
            </button>
          </li>
        ))}
      </ol>
      <div role="tabpanel" id={`${base}-panel`} aria-labelledby={`${base}-${step.id}`} className="mt-4 rounded-xl bg-[var(--color-inset)] p-4">
        <p className="text-xs uppercase tracking-wide text-ink-4">Step {index + 1} of {PIPELINE.length}</p>
        <h4 className="mt-0.5 text-base font-medium text-ink">{step.title}</h4>
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
          <div><dt className="text-xs font-medium text-ink-2">Goes in</dt><dd className="mt-0.5 leading-relaxed text-ink-3">{step.input}</dd></div>
          <div><dt className="text-xs font-medium text-ink-2">Comes out</dt><dd className="mt-0.5 leading-relaxed text-ink-3">{step.output}</dd></div>
        </dl>
        <p className="mt-3 text-xs text-ink-4">Implemented in <code>{step.where}</code></p>
        <div className="mt-3 flex gap-2">
          <button type="button" className="cmp-btn-quiet" disabled={index === 0} onClick={() => setActive(PIPELINE[index - 1].id)}>← Previous</button>
          <button type="button" className="cmp-btn-quiet" disabled={index === PIPELINE.length - 1} onClick={() => setActive(PIPELINE[index + 1].id)}>Next →</button>
        </div>
      </div>
    </div>
  )
}
