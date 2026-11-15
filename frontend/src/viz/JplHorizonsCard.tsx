import { useRef } from 'react'
import { InteractiveGrainGradient } from '../ui/InteractiveGrainGradient'
import type { VerifyResult } from '../types'
import { useDraggable } from './useDraggable'

/**
 * Floating, draggable result card for live JPL Horizons ephemeris verification.
 * Uses the shared Opaline + Coral drag bar convention (matching FloatingSidebar and MeasureCard).
 */
export function JplHorizonsCard({
  result,
  error,
  onClose,
}: {
  result: VerifyResult | null
  error: string | null
  onClose: () => void
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const { pos, size, dragging, handlers } = useDraggable(rootRef)
  const fixed = pos && size

  return (
    <div
      ref={rootRef}
      role="region"
      aria-label="Live check against JPL Horizons"
      className={`lp-light md-reveal pointer-events-auto relative flex flex-col overflow-hidden rounded-[18px] border border-opal-300 bg-opal-50 text-xs text-slate-200 transition-shadow ${
        fixed ? '' : 'recede-behind-menu'
      } ${dragging ? 'shadow-2xl shadow-black/50 ring-1 ring-coral/50' : 'shadow-lg shadow-black/30'}`}
      style={
        fixed
          ? {
              position: 'fixed',
              left: pos.x,
              top: pos.y,
              width: size.w,
              maxWidth: 'calc(100vw - 16px)',
              zIndex: 25,
            }
          : { width: 'min(100%, 30rem)' }
      }
    >
      {/* Coral drag bar with 6-dot grip icon + centered pill handle to signify draggability */}
      <div
        role="presentation"
        data-testid="jpl-drag-handle"
        data-tip="Drag to move anywhere"
        {...handlers}
        className="relative -mx-px flex h-7 w-[calc(100%+2px)] shrink-0 cursor-grab touch-none select-none items-center justify-between bg-coral px-2.5 text-[11px] font-medium text-white transition-[filter] hover:brightness-95 active:cursor-grabbing"
      >
        <InteractiveGrainGradient fill strength={1.6} patternScale={0.45} />
        <span className="relative z-10 flex min-w-0 items-center gap-1.5">
          <svg
            width="10"
            height="14"
            viewBox="0 0 10 14"
            fill="currentColor"
            aria-hidden
            className="shrink-0 opacity-85"
          >
            <circle cx="2.5" cy="2.5" r="1.15" />
            <circle cx="7.5" cy="2.5" r="1.15" />
            <circle cx="2.5" cy="7" r="1.15" />
            <circle cx="7.5" cy="7" r="1.15" />
            <circle cx="2.5" cy="11.5" r="1.15" />
            <circle cx="7.5" cy="11.5" r="1.15" />
          </svg>
          <span className="truncate">Live check against JPL Horizons</span>
        </span>
        <span
          aria-hidden
          className="relative z-10 mx-2 h-1 w-9 shrink-0 rounded-full bg-white/75"
        />
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onClose}
          aria-label="Close"
          data-tip="Close JPL check"
          className="relative z-10 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-white/85 transition-colors hover:bg-white/20 hover:text-white"
        >
          ✕
        </button>
      </div>

      <div className="p-2.5">
        {error && <p className="text-red-300">{error}</p>}
        {result && (
          <>
            <table className="w-full tabular-nums">
              <thead className="text-slate-400">
                <tr>
                  <th className="text-left font-normal">{result.time_utc.replace('T', ' ')}</th>
                  <th className="text-right font-normal">Ours (az / el)</th>
                  <th className="text-right font-normal">JPL Horizons</th>
                  <th className="text-right font-normal">Difference</th>
                </tr>
              </thead>
              <tbody>
                {(['sun', 'earth'] as const).map((b) => {
                  const r = result.bodies[b]
                  return (
                    <tr key={b}>
                      <td className="capitalize">{b}</td>
                      <td className="text-right">
                        {r.stored.azimuth_deg.toFixed(3)}° / {r.stored.elevation_deg.toFixed(3)}°
                      </td>
                      <td className="text-right">
                        {r.horizons.azimuth_deg.toFixed(3)}° / {r.horizons.elevation_deg.toFixed(3)}°
                      </td>
                      <td className={`text-right ${r.stored_vs_horizons_deg < 0.001 ? 'text-emerald-300' : 'text-amber-300'}`}>
                        {r.stored_vs_horizons_deg.toFixed(4)}°
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            <p className="mt-1.5 text-[10px] text-slate-400">
              {result.note} Independent check (Skyfield + DE421) vs JPL: Sun{' '}
              {result.bodies.sun.skyfield_vs_horizons_deg.toFixed(5)}°, Earth{' '}
              {result.bodies.earth.skyfield_vs_horizons_deg.toFixed(5)}°.{' '}
              <a className="text-sky-300 underline" href={result.horizons_example_query} target="_blank" rel="noreferrer">
                Open the Horizons query
              </a>
            </p>
          </>
        )}
      </div>
    </div>
  )
}
