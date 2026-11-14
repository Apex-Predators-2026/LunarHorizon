import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDraggable } from './useDraggable'

const DOW = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const p2 = (n: number) => String(n).padStart(2, '0')

/**
 * Calendar for choosing the simulation time (UTC). Drag it by its title bar. Dates outside the
 * selected site's data range are disabled; the chosen time is clamped into the range.
 */
export function DatePopup({
  timeUtc,
  min,
  max,
  onPick,
  onClose,
}: {
  timeUtc: string // "2027-01-01T12:00:00Z"
  min: string
  max: string
  onPick: (iso: string) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const { pos, handlers } = useDraggable(ref)
  const [year, setYear] = useState(Number(timeUtc.slice(0, 4)))
  const [month, setMonth] = useState(Number(timeUtc.slice(5, 7)) - 1)
  const [closing, setClosing] = useState(false)
  const hhmm = timeUtc.slice(11, 16)

  const clampIso = (iso: string) => (iso < min ? min : iso > max ? max : iso)
  const pickDay = (d: number) => onPick(clampIso(`${year}-${p2(month + 1)}-${p2(d)}T${hhmm}:00Z`))
  const shift = (delta: number) => {
    const d = new Date(Date.UTC(year, month + delta, 1))
    setYear(d.getUTCFullYear())
    setMonth(d.getUTCMonth())
  }

  const firstDow = new Date(Date.UTC(year, month, 1)).getUTCDay()
  const daysIn = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  const cells: (number | null)[] = [...Array(firstDow).fill(null), ...Array.from({ length: daysIn }, (_, i) => i + 1)]
  const dayOk = (d: number) => {
    const day = `${year}-${p2(month + 1)}-${p2(d)}`
    return day >= min.slice(0, 10) && day <= max.slice(0, 10)
  }
  const selectedDay = timeUtc.slice(0, 10)

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label="Choose simulation time (UTC)"
      className={`lp-light pointer-events-auto z-40 w-64 select-none rounded-2xl bg-opal-50 text-xs shadow-xl shadow-black/40 ${closing ? 'md-dialog-out' : 'md-dialog-in'}`}
      onAnimationEnd={(e) => {
        if (closing && e.target === e.currentTarget) onClose()
      }}
      style={{ textShadow: 'none', position: 'fixed', ...(pos ? { left: pos.x, top: pos.y } : { left: 'clamp(16px,4.5vw,65px)', top: 150 }) }}
    >
      <div
        {...handlers}
        className="flex cursor-grab touch-none items-center justify-between rounded-t-2xl bg-coral px-3 py-1.5 font-semibold text-white active:cursor-grabbing"
        title="Drag to move"
      >
        <span>Time (UTC)</span>
        <button type="button" aria-label="Close calendar" onPointerDown={(e) => e.stopPropagation()} onClick={() => setClosing(true)} className="px-1 text-base leading-none hover:opacity-80">
          ×
        </button>
      </div>
      <div className="p-3">
        <div className="mb-2 flex items-center justify-between">
          <button type="button" aria-label="Previous month" onClick={() => shift(-1)} className="rounded-lg px-2 py-0.5 hover:bg-calcite-peach/40">‹</button>
          <span className="font-semibold">{MONTHS[month]} {year}</span>
          <button type="button" aria-label="Next month" onClick={() => shift(1)} className="rounded-lg px-2 py-0.5 hover:bg-calcite-peach/40">›</button>
        </div>
        <div className="grid grid-cols-7 gap-0.5 text-center">
          {DOW.map((d) => (
            <span key={d} className="py-0.5 text-slate-500">{d}</span>
          ))}
          {cells.map((d, i) =>
            d === null ? (
              <span key={`b${i}`} />
            ) : (
              <button
                key={d}
                type="button"
                disabled={!dayOk(d)}
                onClick={() => pickDay(d)}
                aria-pressed={selectedDay === `${year}-${p2(month + 1)}-${p2(d)}`}
                className={`rounded-lg py-1 tabular-nums transition-colors disabled:opacity-30 ${
                  selectedDay === `${year}-${p2(month + 1)}-${p2(d)}` ? 'bg-coral font-semibold text-white' : 'hover:bg-calcite-peach/40'
                }`}
              >
                {d}
              </button>
            ),
          )}
        </div>
        <label className="mt-3 flex items-center justify-between gap-2 text-slate-400">
          Time
          <input
            type="time"
            value={hhmm}
            onChange={(e) => e.target.value && onPick(clampIso(`${selectedDay}T${e.target.value}:00Z`))}
            className="rounded-lg border border-opal-300 bg-white px-2 py-1 text-calcite-ink"
          />
        </label>
      </div>
    </div>,
    document.body,
  )
}
