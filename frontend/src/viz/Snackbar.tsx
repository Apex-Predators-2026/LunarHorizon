import { useEffect, useState } from 'react'
import { useSnackbarStore } from './snackbarStore'

const SHOW_MS = 4000
const EXIT_MS = 150

const ICON = {
  success: 'M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
  error: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z',
  info: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z',
}

/**
 * M3 snackbar (https://m3.material.io/components/snackbar): a short message on an inverse-surface
 * container that slides in, waits a few seconds, then fades out. One at a time; later ones queue.
 * Pauses its timer while hovered or focused.
 */
export function SnackbarHost() {
  const current = useSnackbarStore((s) => s.queue[0])
  const shift = useSnackbarStore((s) => s.shift)
  const [closing, setClosing] = useState(false)
  const [paused, setPaused] = useState(false)
  const id = current?.id

  useEffect(() => {
    if (id === undefined || paused) return
    const t = setTimeout(() => setClosing(true), SHOW_MS)
    return () => clearTimeout(t)
  }, [id, paused])

  useEffect(() => {
    if (!closing) return
    const t = setTimeout(() => {
      setClosing(false)
      shift()
    }, EXIT_MS)
    return () => clearTimeout(t)
  }, [closing, shift])

  if (!current) return null
  return (
    <div className="pointer-events-none absolute bottom-6 left-0 right-0 z-40 flex justify-center px-4 md:right-[calc(4vw+var(--lp-side-w)+16px)]">
      <div
        key={current.id}
        role={current.tone === 'error' ? 'alert' : 'status'}
        aria-live={current.tone === 'error' ? 'assertive' : 'polite'}
        onPointerEnter={() => setPaused(true)}
        onPointerLeave={() => setPaused(false)}
        className={`pointer-events-auto flex min-h-12 w-full max-w-[34rem] items-center gap-3 rounded bg-[#322f35] py-2 pl-4 pr-2 text-sm text-[#f5eff7] shadow-lg shadow-black/50 ${
          closing ? 'md-snack-out' : 'md-snack-in'
        }`}
        style={{ fontFamily: 'var(--font-inter)' }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden className={current.tone === 'error' ? 'text-[#ffb4ab]' : current.tone === 'success' ? 'text-[#9be3a8]' : 'text-[#d0bcff]'}>
          <path d={ICON[current.tone]} />
        </svg>
        <span className="min-w-0 flex-1 leading-snug">{current.text}</span>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => setClosing(true)}
          className="md-snack-close flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[#f5eff7]"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
          </svg>
        </button>
      </div>
    </div>
  )
}
