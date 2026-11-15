// Small, framework-free helpers for the M3 interactions CSS cannot do on its own:
// a press ripple on buttons, and the active-track fill of range sliders.
// Only acts inside .lp-light / .md-host, so other pages are unaffected.
import { playUiTap } from './sfx'
import { isLiteUi } from './graphics'

const SCOPE = '.lp-light, .md-host'

function ripple(e: PointerEvent) {
  if (e.button !== 0) return
  const target = e.target as Element | null
  const btn = target?.closest<HTMLButtonElement>('button')
  if (!btn || btn.disabled || !btn.closest(SCOPE)) return
  if (!btn.hasAttribute('data-no-sfx')) playUiTap()
  if (btn.hasAttribute('data-no-ripple') || isLiteUi()) return
  const rect = btn.getBoundingClientRect()
  const x = e.clientX - rect.left
  const y = e.clientY - rect.top
  const r = Math.hypot(Math.max(x, rect.width - x), Math.max(y, rect.height - y))
  const dot = document.createElement('span')
  dot.className = 'md-ripple'
  dot.setAttribute('aria-hidden', 'true')
  Object.assign(dot.style, { width: `${2 * r}px`, height: `${2 * r}px`, left: `${x - r}px`, top: `${y - r}px` })
  btn.appendChild(dot)
  const grow = dot.animate([{ transform: 'scale(0)' }, { transform: 'scale(1)' }], {
    duration: 450,
    easing: 'cubic-bezier(0.05, 0.7, 0.1, 1)',
    fill: 'forwards',
  })
  const release = () => {
    window.removeEventListener('pointerup', release)
    window.removeEventListener('pointercancel', release)
    const fade = () => dot.animate([{ opacity: 0.14 }, { opacity: 0 }], { duration: 250, fill: 'forwards' }).finished
    setTimeout(() => dot.remove(), 1200) // safety net if the animation is paused (background tab)
    grow.finished.then(fade).then(() => dot.remove(), () => dot.remove())
  }
  window.addEventListener('pointerup', release)
  window.addEventListener('pointercancel', release)
}

function syncRange(el: HTMLInputElement) {
  const min = Number(el.min || 0)
  const max = Number(el.max || 100)
  el.style.setProperty('--p', String(max > min ? (Number(el.value) - min) / (max - min) : 0))
}

export function initMaterialMotion(): () => void {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
  const onDown = (e: PointerEvent) => {
    if (!reduced.matches) ripple(e)
  }
  const onInput = (e: Event) => {
    const t = e.target
    if (t instanceof HTMLInputElement && t.type === 'range') syncRange(t)
  }
  const syncAll = () => document.querySelectorAll<HTMLInputElement>('.lp-light input[type="range"]').forEach(syncRange)
  document.addEventListener('pointerdown', onDown)
  document.addEventListener('input', onInput, true)
  const mo = new MutationObserver(syncAll)
  mo.observe(document.body, { childList: true, subtree: true })
  syncAll()
  return () => {
    document.removeEventListener('pointerdown', onDown)
    document.removeEventListener('input', onInput, true)
    mo.disconnect()
  }
}
