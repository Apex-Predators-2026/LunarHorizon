import { coverageLabel, useCoverage } from './globe/coverage'

/**
 * Bottom-left note on which surface data the 3D view shows (LOLA terrain close up, the LRO photo mosaic
 * zoomed out, or the blend between), with a small bar for how far the fade has gone.
 */
export function CoverageBadge() {
  const mixPct = useCoverage((s) => s.mixPct)
  const { title, detail, tip } = coverageLabel(mixPct)
  return (
    <div
      role="status"
      aria-label={`Surface: ${title}, ${detail}`}
      data-tip={tip}
      className="pointer-events-auto w-60 rounded-xl bg-slate-950/70 px-3 py-1.5 text-[11px] leading-tight text-slate-200 shadow-lg shadow-black/30"
    >
      <div className="truncate font-medium text-slate-100">{title}</div>
      <div className="mt-0.5 truncate text-slate-400">{detail}</div>
      <div className="mt-1 flex h-1 overflow-hidden rounded-full" aria-hidden>
        <div className="h-full bg-slate-400 transition-[width] duration-150" style={{ width: `${100 - mixPct}%` }} />
        <div className="h-full bg-coral transition-[width] duration-150" style={{ width: `${mixPct}%` }} />
      </div>
    </div>
  )
}
