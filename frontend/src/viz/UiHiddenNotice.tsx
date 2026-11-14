import { useEffect } from 'react'
import { useUiPrefs } from './uiPrefs'

/**
 * "Interface hidden" notice, and the Esc handler that brings the interface back. Lives outside the
 * hidden chrome so it is still there when everything else has faded away.
 */
export function UiHiddenNotice() {
  const notice = useUiPrefs((s) => s.notice)
  const uiHidden = useUiPrefs((s) => s.uiHidden)
  const showUi = useUiPrefs((s) => s.showUi)

  useEffect(() => {
    if (!uiHidden && !notice) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') showUi()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [uiHidden, notice, showUi])

  return (
    <div
      role="status"
      aria-live="polite"
      className={`pointer-events-none absolute inset-x-0 bottom-10 z-50 flex justify-center px-4 transition-opacity duration-300 ${notice ? 'opacity-100' : 'opacity-0'}`}
    >
      <div className="rounded-full bg-[#322f35] px-5 py-3 text-sm text-[#f5eff7] shadow-lg shadow-black/50" style={{ fontFamily: 'var(--font-inter)' }}>
        {uiHidden ? 'Interface hidden. ' : 'Hiding the interface. '}
        Press <kbd className="rounded bg-white/15 px-1.5 py-0.5 text-xs font-semibold">Esc</kbd> to bring it back.
      </div>
    </div>
  )
}
