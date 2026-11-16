import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { TextField } from '../ui/MdFields'
import { useDraggable } from './useDraggable'

const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const SHORT_DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const SHORT_MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const p2 = (n: number) => String(n).padStart(2, '0')
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/

const ICON = {
  edit: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z',
  calendar: 'M19 4h-1V2h-2v2H8V2H6v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 16H5V10h14v10zM5 8V6h14v2H5z',
  left: 'M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z',
  right: 'M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z',
  down: 'M7 10l5 5 5-5z',
}
const Icon = ({ d }: { d: string }) => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d={d} />
  </svg>
)

/** Valid calendar date as "YYYY-MM-DD" -> [y, m0, d], else null. */
function parseDay(s: string): [number, number, number] | null {
  const m = ISO_DAY.exec(s)
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])]
  const dt = new Date(Date.UTC(y, mo, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo && dt.getUTCDate() === d ? [y, mo, d] : null
}

/**
 * M3 modal date picker (https://m3.material.io/components/date-pickers) for the simulation time (UTC):
 * header with the chosen date, calendar / year / text-input modes, a time field and Cancel / OK.
 * Drag it by its header. Days outside the site's data range are disabled.
 */
export function DatePopup({
  timeUtc,
  min,
  max,
  dateOnly = false,
  onPick,
  onClose,
}: {
  timeUtc: string // "2027-01-01T12:00:00Z"
  min: string
  max: string
  dateOnly?: boolean
  onPick: (iso: string) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const yearsRef = useRef<HTMLDivElement>(null)
  const { pos, handlers } = useDraggable(ref)
  const [closing, setClosing] = useState(false)
  const [day, setDay] = useState(timeUtc.slice(0, 10)) // the draft: only applied on OK
  const [hhmm, setHhmm] = useState(timeUtc.slice(11, 16))
  const [year, setYear] = useState(Number(timeUtc.slice(0, 4)))
  const [month, setMonth] = useState(Number(timeUtc.slice(5, 7)) - 1)
  const [mode, setMode] = useState<'calendar' | 'year' | 'input'>('calendar')
  const [typed, setTyped] = useState(timeUtc.slice(0, 10))

  const minDay = min.slice(0, 10)
  const maxDay = max.slice(0, 10)
  const inRange = (d: string) => d >= minDay && d <= maxDay
  const clampIso = (iso: string) => (iso < min ? min : iso > max ? max : iso)
  const today = new Date().toISOString().slice(0, 10)

  const parsed = parseDay(day)
  const headline = parsed
    ? `${SHORT_DOW[new Date(Date.UTC(...parsed)).getUTCDay()]}, ${SHORT_MONTH[parsed[1]]} ${parsed[2]}`
    : 'Select date'
  const typedParsed = parseDay(typed)
  const typedError = mode !== 'input' ? null : !typedParsed ? 'Use the format YYYY-MM-DD' : !inRange(typed) ? `Choose a date from ${minDay} to ${maxDay}` : null
  const canOk = mode === 'input' ? !typedError : parsed !== null && inRange(day)

  const shift = (delta: number) => {
    const d = new Date(Date.UTC(year, month + delta, 1))
    setYear(d.getUTCFullYear())
    setMonth(d.getUTCMonth())
  }
  const pickDay = (d: number) => setDay(`${year}-${p2(month + 1)}-${p2(d)}`)

  const ok = () => {
    const chosen = mode === 'input' ? typed : day
    onPick(clampIso(`${chosen}T${dateOnly ? '00:00' : hhmm || '00:00'}:00Z`))
    setClosing(true)
  }
  const toggleInput = () => {
    if (mode === 'input') {
      const p = parseDay(typed)
      if (p && inRange(typed)) {
        setDay(typed)
        setYear(p[0])
        setMonth(p[1])
      }
      setMode('calendar')
    } else {
      setTyped(day)
      setMode('input')
    }
  }

  const firstDow = new Date(Date.UTC(year, month, 1)).getUTCDay()
  const daysIn = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  const cells: (number | null)[] = [...Array(firstDow).fill(null), ...Array.from({ length: daysIn }, (_, i) => i + 1)]
  const yMin = Number(minDay.slice(0, 4))
  const yMax = Number(maxDay.slice(0, 4))
  const years = Array.from({ length: Math.min(yMax, year + 60) - Math.max(yMin, year - 60) + 1 }, (_, i) => Math.max(yMin, year - 60) + i)

  useEffect(() => {
    if (mode === 'year') yearsRef.current?.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: 'center' })
  }, [mode])

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={dateOnly ? 'Select date (UTC)' : 'Select date and time (UTC)'}
      className={`ui-chrome lp-light pointer-events-auto z-[70] w-[328px] select-none overflow-hidden rounded-[28px] bg-opal-50 text-calcite-ink shadow-2xl shadow-black/50 ${closing ? 'md-dialog-out' : 'md-dialog-in'}`}
      style={{ textShadow: 'none', position: 'fixed', ...(pos ? { left: pos.x, top: pos.y } : { left: 'clamp(16px,4.5vw,65px)', top: 150 }) }}
      onAnimationEnd={(e) => {
        if (closing && e.target === e.currentTarget) onClose()
      }}
    >
      {/* Header: drag handle. */}
      <div {...handlers} data-tip="Drag to move" className="cursor-grab touch-none px-6 pb-3 pt-5 active:cursor-grabbing">
        <p className="text-xs tracking-wide text-slate-400">{mode === 'input' ? 'Enter date' : 'Select date'} · UTC</p>
        <div className="mt-3 flex items-center justify-between">
          <h2 className="text-[28px] font-normal leading-9">{mode === 'input' ? 'Enter date' : headline}</h2>
          <button
            type="button"
            aria-label={mode === 'input' ? 'Switch to calendar' : 'Switch to text input'}
            data-tip={mode === 'input' ? 'Switch to the calendar' : 'Type the date instead'}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={toggleInput}
            className="flex h-10 w-10 items-center justify-center rounded-full text-slate-400"
          >
            <Icon d={mode === 'input' ? ICON.calendar : ICON.edit} />
          </button>
        </div>
      </div>
      <div className="h-px bg-opal-300" />

      <div className="px-3 pb-2 pt-3">
        {mode === 'input' ? (
          <div className="px-3 pb-2 pt-2" style={{ ['--md-field-bg' as string]: 'var(--color-opal-50)' }}>
            <TextField
              label="Date"
              placeholder="YYYY-MM-DD"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              inputMode="numeric"
              maxLength={10}
              aria-invalid={!!typedError}
              tip="Type a date as year-month-day"
            />
            <p className={`md-field-support ${typedError ? 'text-field-error' : ''}`}>{typedError ?? 'Year-month-day, e.g. 2027-01-15'}</p>
          </div>
        ) : (
          <>
            <div className="mb-1 flex items-center justify-between pl-3">
              <button
                type="button"
                aria-expanded={mode === 'year'}
                onClick={() => setMode(mode === 'year' ? 'calendar' : 'year')}
                data-tip="Choose a year"
                className="flex h-10 items-center gap-1 rounded-full pl-3 pr-1 text-sm font-semibold"
              >
                {MONTHS[month]} {year}
                <span className={`transition-transform duration-200 ${mode === 'year' ? 'rotate-180' : ''}`}>
                  <Icon d={ICON.down} />
                </span>
              </button>
              {mode === 'calendar' && (
                <div className="flex">
                  <button type="button" aria-label="Previous month" data-tip="Previous month" onClick={() => shift(-1)} className="flex h-10 w-10 items-center justify-center rounded-full">
                    <Icon d={ICON.left} />
                  </button>
                  <button type="button" aria-label="Next month" data-tip="Next month" onClick={() => shift(1)} className="flex h-10 w-10 items-center justify-center rounded-full">
                    <Icon d={ICON.right} />
                  </button>
                </div>
              )}
            </div>
            {mode === 'year' ? (
              <div ref={yearsRef} className="md-reveal grid max-h-56 grid-cols-3 gap-y-1 overflow-y-auto px-2 py-1">
                {years.map((y) => (
                  <button
                    key={y}
                    type="button"
                    aria-pressed={y === year}
                    onClick={() => {
                      setYear(y)
                      setMode('calendar')
                    }}
                    className={`mx-auto h-9 w-[72px] rounded-full text-sm tabular-nums ${y === year ? 'bg-coral font-semibold text-white' : ''}`}
                  >
                    {y}
                  </button>
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-7 gap-y-1 px-1" role="grid" aria-label={`${MONTHS[month]} ${year}`}>
                {DOW.map((d, i) => (
                  <span key={i} className="flex h-10 items-center justify-center text-xs text-slate-400">
                    {d}
                  </span>
                ))}
                {cells.map((d, i) => {
                  if (d === null) return <span key={`b${i}`} />
                  const iso = `${year}-${p2(month + 1)}-${p2(d)}`
                  return (
                    <button
                      key={iso}
                      type="button"
                      disabled={!inRange(iso)}
                      aria-pressed={day === iso}
                      data-today={iso === today}
                      aria-label={`${MONTHS[month]} ${d}, ${year}`}
                      onClick={() => pickDay(d)}
                      className="md-dp-day"
                    >
                      {d}
                    </button>
                  )
                })}
              </div>
            )}
          </>
        )}

        {!dateOnly && (
          <div className="mt-2 px-3" style={{ ['--md-field-bg' as string]: 'var(--color-opal-50)' }}>
            <TextField label="Time (UTC)" type="time" value={hhmm} onChange={(e) => setHhmm(e.target.value)} tip="Time of day in UTC" />
          </div>
        )}
      </div>

      <div className="flex justify-end gap-2 px-3 pb-3 pt-3">
        <button type="button" className="md-dp-text-button" onClick={() => setClosing(true)}>
          Cancel
        </button>
        <button type="button" className="md-dp-text-button" disabled={!canOk} onClick={ok}>
          OK
        </button>
      </div>
    </div>,
    document.body,
  )
}
