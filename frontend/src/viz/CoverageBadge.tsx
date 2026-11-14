import { coverageLabel, useCoverage } from './globe/coverage'

/**
 * Bottom-right note on which surface data the 3D view shows (LOLA terrain close up, the LRO photo mosaic
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
      className="pointer-events-auto w-60 text-right text-[10px] leading-tight text-white"
      style={{ textShadow: '0 1px 4px rgba(0,0,0,0.9)' }}
    >
      <div className="truncate">{title}</div>
      <div className="mt-0.5 truncate text-white/80">{detail}</div>
      {/* White progress bar: how far the photo mosaic has faded in. */}
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/25" aria-hidden>
        <div className="h-full rounded-full bg-white transition-[width] duration-150" style={{ width: `${mixPct}%` }} />
      </div>
    </div>
  )
}
