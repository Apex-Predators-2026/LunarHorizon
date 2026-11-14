import { useEffect, useLayoutEffect, useRef, useState } from 'react'

const SHOW_DELAY_MS = 450 // hover; keyboard focus shows at once
const GAP = 8

/**
 * M3 plain tooltips for anything with a data-tip="..." attribute. One instance for the app: it listens
 * for hover / keyboard focus, shows a small dark label near the element and hides on leave, press,
 * scroll or Escape.
 */
export function TooltipHost() {
  const [tip, setTip] = useState<{ text: string; rect: DOMRect } | null>(null)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const timer = useRef<number>(0)
  const anchor = useRef<Element | null>(null)

  useEffect(() => {
    const find = (t: EventTarget | null) => (t instanceof Element ? t.closest('[data-tip]') : null)
    const hide = () => {
      window.clearTimeout(timer.current)
      anchor.current = null
      setOpen(false)
    }
    const show = (el: Element, delay: number) => {
      if (!el.getAttribute('data-tip')) return
      window.clearTimeout(timer.current)
      anchor.current = el
      timer.current = window.setTimeout(() => {
        const text = el.getAttribute('data-tip') // read again: it may have been removed meanwhile
        if (!text || anchor.current !== el || !el.isConnected) return
        setPos(null)
        setTip({ text, rect: el.getBoundingClientRect() })
        setOpen(true)
      }, delay)
    }
    const onOver = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return
      const el = find(e.target)
      if (el && el !== anchor.current) show(el, SHOW_DELAY_MS)
      else if (!el) hide()
    }
    const onFocus = (e: FocusEvent) => {
      const el = find(e.target)
      if (el && (e.target as Element).matches(':focus-visible')) show(el, 0)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && hide()
    document.addEventListener('pointerover', onOver)
    document.addEventListener('focusin', onFocus)
    document.addEventListener('focusout', hide)
    document.addEventListener('pointerdown', hide, true)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', hide, true)
    return () => {
      window.clearTimeout(timer.current)
      document.removeEventListener('pointerover', onOver)
      document.removeEventListener('focusin', onFocus)
      document.removeEventListener('focusout', hide)
      document.removeEventListener('pointerdown', hide, true)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', hide, true)
    }
  }, [])

  // Place below the element (above when there is no room), centred and kept inside the window.
  useLayoutEffect(() => {
    if (!tip || !ref.current) return
    const w = ref.current.offsetWidth
    const h = ref.current.offsetHeight
    const r = tip.rect
    let top = r.bottom + GAP
    if (top + h > window.innerHeight - 4) top = Math.max(4, r.top - GAP - h)
    const left = Math.min(Math.max(4, r.left + r.width / 2 - w / 2), window.innerWidth - w - 4)
    setPos({ left, top })
  }, [tip])

  if (!tip) return null
  return (
    <div
      ref={ref}
      role="tooltip"
      data-open={open && pos !== null}
      className="md-tooltip"
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0 }}
      onTransitionEnd={() => !open && setTip(null)}
    >
      {tip.text}
    </div>
  )
}
